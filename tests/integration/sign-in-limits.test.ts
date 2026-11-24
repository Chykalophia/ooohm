import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { SIGN_IN_LINK_MINUTES } from "@/lib/sign-in-email";
import { countSignInLinksSince, mayEmailSignInLink, SIGN_IN_EMAILS_PER_ADDRESS } from "@/lib/sign-in-throttle";
import { pruneExpiredSignIns } from "@/server/services/retention";
import { DAILY_JOBS } from "@/server/services/scheduled-jobs";
import { seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

const MINUTE = 60_000;
const NOW = new Date("2026-11-24T12:00:00Z");

/** A row as Better Auth's magic-link plugin writes it. */
const link = (email: string, createdAt: Date) => ({
  id: randomUUID(),
  identifier: `magic-link:${randomUUID()}`,
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
    await t.db.insert(schema.verification).values(link(email, NOW));
    assert.equal(await mayEmailSignInLink(t.db, email, NOW), true, "the fifth link goes out");
    await t.db.insert(schema.verification).values(link(email, NOW));
    assert.equal(await mayEmailSignInLink(t.db, email, NOW), false, "the sixth does not");
    assert.equal(await mayEmailSignInLink(t.db, email, new Date(NOW.getTime() + (SIGN_IN_LINK_MINUTES + 1) * MINUTE)), true, "a window later it does");
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

    const summary = await DAILY_JOBS.integration_retention(createTestContext(t.db, { now: NOW }));
    assert.equal(summary.verifications, 0, "the daily job runs the same prune");
    assert.equal(summary.sessions, 0);
  });
});
