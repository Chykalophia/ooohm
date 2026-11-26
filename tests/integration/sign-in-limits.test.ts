import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { eq, like, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { SIGN_IN_LINK_MINUTES } from "@/lib/sign-in-email";
import { countSignInLinksSince, discardSignInLink, mayEmailSignInLink, SIGN_IN_EMAILS_PER_ADDRESS } from "@/lib/sign-in-throttle";
import { pruneExpiredSignIns } from "@/server/services/retention";
import { DAILY_JOBS } from "@/server/services/scheduled-jobs";
import { seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

const MINUTE = 60_000;
const NOW = new Date("2026-11-24T12:00:00Z");

/** A row as Better Auth's magic-link plugin writes it. */
const link = (email: string, createdAt: Date, token: string = randomUUID()) => ({
  id: randomUUID(),
  identifier: `magic-link:${token}`,
  value: JSON.stringify({ type: "magic-link", email }),
  expiresAt: new Date(createdAt.getTime() + SIGN_IN_LINK_MINUTES * MINUTE),
  createdAt,
  updatedAt: createdAt,
});

describe("sign-in limits and leftovers", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  test("one address gets at most five sign-in links in fifteen minutes, whoever asks", async () => {
    const email = `cap-${randomUUID().slice(0, 8)}@example.com`;
    const recent = new Date(NOW.getTime() - 5 * MINUTE);
    const old = new Date(NOW.getTime() - (SIGN_IN_LINK_MINUTES + 1) * MINUTE);
    await t.db.insert(schema.verification).values([
      ...Array.from({ length: SIGN_IN_EMAILS_PER_ADDRESS - 1 }, () => link(email.toUpperCase(), recent)),
      link(email, old),
      link("someone-else@example.com", recent),
      // A passkey challenge: not JSON, and never counted.
      { id: randomUUID(), identifier: randomUUID(), value: "not json", expiresAt: NOW, createdAt: recent, updatedAt: recent },
    ]);
    assert.equal(await countSignInLinksSince(t.db, email, new Date(NOW.getTime() - SIGN_IN_LINK_MINUTES * MINUTE)), SIGN_IN_EMAILS_PER_ADDRESS - 1);

    // The row for the link being sent is written before the email goes, so it counts.
    await t.db.insert(schema.verification).values(link(email, NOW, "fifth"));
    assert.equal(await mayEmailSignInLink(t.db, email, "fifth", NOW), true, "the fifth link goes out");
    const sixthAt = new Date(NOW.getTime() + 1000);
    await t.db.insert(schema.verification).values(link(email, sixthAt, "sixth"));
    assert.equal(await mayEmailSignInLink(t.db, email, "sixth", sixthAt), false, "the sixth does not");
    await discardSignInLink(t.db, "sixth");
    const later = new Date(NOW.getTime() + (SIGN_IN_LINK_MINUTES + 1) * MINUTE);
    await t.db.insert(schema.verification).values(link(email, later, "later"));
    assert.equal(await mayEmailSignInLink(t.db, email, "later", later), true, "a window later it does");
    assert.equal(await mayEmailSignInLink(t.db, email, "never-stored", later), false, "a link whose row is gone is never sent");
  });

  test("requests checked at the same moment are admitted in the order they were stored", async () => {
    const email = `burst-${randomUUID().slice(0, 8)}@example.com`;
    const tokens = Array.from({ length: SIGN_IN_EMAILS_PER_ADDRESS + 2 }, () => randomUUID());
    // Every row is stored before any check runs, as with requests arriving together.
    await t.db.insert(schema.verification).values(tokens.map((token, i) => link(email, new Date(NOW.getTime() + i), token)));
    const admitted = await Promise.all(tokens.map((token) => mayEmailSignInLink(t.db, email, token, NOW)));
    assert.deepEqual(admitted, tokens.map((_, i) => i < SIGN_IN_EMAILS_PER_ADDRESS));
  });

  test("a refused link is deleted, so asking again and again never pushes the window out", async () => {
    const email = `refused-${randomUUID().slice(0, 8)}@example.com`;
    const sent = new Date(NOW.getTime() - 2 * MINUTE);
    await t.db.insert(schema.verification).values(Array.from({ length: SIGN_IN_EMAILS_PER_ADDRESS }, () => link(email, sent)));
    // Someone keeps asking every two minutes: each request is refused and its link discarded.
    for (let minutes = 0; minutes <= 12; minutes += 2) {
      const at = new Date(NOW.getTime() + minutes * MINUTE);
      const token = randomUUID();
      await t.db.insert(schema.verification).values(link(email, at, token));
      assert.equal(await mayEmailSignInLink(t.db, email, token, at), false);
      await discardSignInLink(t.db, token);
    }
    const [kept] = await t.db.select({ n: sql<number>`count(*)` }).from(schema.verification).where(like(schema.verification.value, `%${email}%`));
    assert.equal(Number(kept.n), SIGN_IN_EMAILS_PER_ADDRESS, "only the links that went out are left");
    // Fifteen minutes after the sent ones, the address gets a link again.
    const later = new Date(sent.getTime() + (SIGN_IN_LINK_MINUTES + 1) * MINUTE);
    await t.db.insert(schema.verification).values(link(email, later, "after"));
    assert.equal(await mayEmailSignInLink(t.db, email, "after", later), true);
  });

  test("the daily retention job deletes sign-in links and sessions a day past expiry, and keeps the rest", async () => {
    const co = await seedCompany(t.db, { ana: {} });
    const userId = co.people.ana.id;
    const longGone = new Date(NOW.getTime() - 2 * 86_400_000);
    const justExpired = new Date(NOW.getTime() - 60 * MINUTE);
    const live = new Date(NOW.getTime() + 60 * MINUTE);
    const verification = (expiresAt: Date) => ({ ...link("gone@example.com", longGone), expiresAt });
    const [gone, recent, current] = await t.db
      .insert(schema.verification)
      .values([verification(longGone), verification(justExpired), verification(live)])
      .returning();
    const session = (expiresAt: Date) => ({ id: randomUUID(), token: randomUUID(), userId, expiresAt });
    const [oldSession, liveSession] = await t.db.insert(schema.session).values([session(longGone), session(live)]).returning();

    const pruned = await pruneExpiredSignIns(createTestContext(t.db, { now: NOW }));
    assert.ok(pruned.verifications >= 1 && pruned.sessions >= 1);
    const left = new Set((await t.db.select({ id: schema.verification.id }).from(schema.verification)).map((r) => r.id));
    assert.ok(!left.has(gone.id), "expired two days ago: deleted");
    assert.ok(left.has(recent.id), "expired within the day: kept");
    assert.ok(left.has(current.id), "still valid: kept");
    const sessions = await t.db.select({ id: schema.session.id }).from(schema.session).where(eq(schema.session.userId, userId));
    assert.deepEqual(sessions.map((s) => s.id), [liveSession.id]);
    assert.notEqual(oldSession.id, liveSession.id);

    // The daily job runs the same prune.
    const [later] = await t.db.insert(schema.verification).values(verification(longGone)).returning();
    const [laterSession] = await t.db.insert(schema.session).values(session(longGone)).returning();
    const summary = await DAILY_JOBS.integration_retention(createTestContext(t.db, { now: NOW }));
    assert.equal(summary.verifications, 1);
    assert.equal(summary.sessions, 1);
    assert.equal((await t.db.select().from(schema.verification).where(eq(schema.verification.id, later.id))).length, 0);
    assert.equal((await t.db.select().from(schema.session).where(eq(schema.session.id, laterSession.id))).length, 0);
  });
});
