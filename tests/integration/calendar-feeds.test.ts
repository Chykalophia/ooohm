import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/db/schema";
import type { Database } from "@/db/types";
import type { LeaveStatus } from "@/domain/leave-request";
import { issueCalendarFeed, listCalendarFeeds, renderCalendarFeed, revokeCalendarFeed } from "@/server/services/calendar-feeds";
import { only, parseIcs, unescapeText } from "../support/ics-parser";
import { rejectsWith } from "./assertions";
import { seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

// The test clock is 2026-11-01 15:00 UTC (Nov 1 in Chicago), so feeds cover
// 2026-08-03 to 2028-05-02.

async function book(
  db: Database,
  companyId: string,
  userId: string,
  leaveTypeId: string,
  b: { startDate: string; endDate?: string; status?: LeaveStatus; dayPortion?: "full" | "am" | "pm"; note?: string; decisionNote?: string },
) {
  const [row] = await db
    .insert(schema.leaveRequests)
    .values({
      companyId,
      userId,
      leaveTypeId,
      startDate: b.startDate,
      endDate: b.endDate ?? b.startDate,
      dayPortion: b.dayPortion ?? "full",
      days: b.dayPortion && b.dayPortion !== "full" ? 0.5 : 1,
      status: b.status ?? "approved",
      note: b.note ?? null,
      decisionNote: b.decisionNote ?? null,
    })
    .returning();
  return row;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The feed's events as `[uid, summary, status, start, end]`, from a strict parse. */
function eventsOf(body: string) {
  return parseIcs(body).components.map((e) => [
    only(e, "UID").value,
    unescapeText(only(e, "SUMMARY").value),
    only(e, "STATUS").value,
    only(e, "DTSTART").value,
    only(e, "DTEND").value,
  ]);
}

async function feedAudit(db: Database, companyId: string) {
  return db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.companyId, companyId), eq(schema.auditLog.entityType, "calendar_feed")))
    .orderBy(asc(schema.auditLog.createdAt));
}

async function feedEvents(db: Database, companyId: string) {
  const rows = await db
    .select()
    .from(schema.eventsOutbox)
    .where(eq(schema.eventsOutbox.companyId, companyId))
    .orderBy(asc(schema.eventsOutbox.createdAt));
  return rows.filter((r) => r.type.startsWith("calendar_feed."));
}

describe("calendar feeds", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  test("issuing stores only the token's hash, and audits and records the event without the token", async () => {
    const co = await seedCompany(t.db, { ana: {} });
    const ctx = createTestContext(t.db);
    const { ana } = co.people;

    const issued = await issueCalendarFeed(ctx, ana, "personal");
    assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.url, `https://ooohm.test/api/ics/${issued.token}.ics`);

    const rows = await t.db.select().from(schema.calendarFeedTokens).where(eq(schema.calendarFeedTokens.userId, ana.id));
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { kind: rows[0].kind, hash: rows[0].tokenHash, companyId: rows[0].companyId, revokedAt: rows[0].revokedAt, lastUsedAt: rows[0].lastUsedAt },
      { kind: "personal", hash: sha256(issued.token), companyId: co.companyId, revokedAt: null, lastUsedAt: null },
    );

    // The token appears nowhere in the database: not in any table's text.
    const [{ hits }] = await t.db.execute<{ hits: number }>(sql`
      select (
        (select count(*) from calendar_feed_tokens c where c::text like ${"%" + issued.token + "%"}) +
        (select count(*) from audit_log a where a::text like ${"%" + issued.token + "%"}) +
        (select count(*) from events_outbox e where e::text like ${"%" + issued.token + "%"})
      )::int as hits`);
    assert.equal(hits, 0);

    const audit = await feedAudit(t.db, co.companyId);
    assert.deepEqual(
      audit.map((a) => [a.action, a.entityId, a.actorId, a.before, a.after]),
      [["calendar_feed.issued", rows[0].id, ana.id, null, { kind: "personal", createdAt: rows[0].createdAt.toISOString(), revokedAt: null }]],
    );
    const events = await feedEvents(t.db, co.companyId);
    assert.deepEqual(
      events.map((e) => [e.type, e.payload]),
      [["calendar_feed.issued", { feedId: rows[0].id, userId: ana.id, kind: "personal", reason: null, actorId: ana.id }]],
    );
    assert.ok(!JSON.stringify([audit, events]).includes(rows[0].tokenHash), "nor its hash");

    const { feeds } = await listCalendarFeeds(ctx, ana);
    assert.deepEqual(feeds, { personal: { createdAt: rows[0].createdAt, lastUsedAt: null }, team: null });
  });

  test("a personal feed: my approved and pending leave in the window, valid ICS, nothing of anyone else's", async () => {
    const co = await seedCompany(t.db, { ana: {}, ben: {} });
    const { ana, ben } = co.people;
    const ctx = createTestContext(t.db);
    const week = await book(t.db, co.companyId, ana.id, co.pto, { startDate: "2026-11-23", endDate: "2026-11-27", note: "SECRET-MINE" });
    const half = await book(t.db, co.companyId, ana.id, co.pto, { startDate: "2026-12-31", dayPortion: "pm", status: "pending" });
    const early = await book(t.db, co.companyId, ana.id, co.pto, { startDate: "2026-08-01", endDate: "2026-08-03" });
    await book(t.db, co.companyId, ana.id, co.pto, { startDate: "2026-11-30", status: "rejected" });
    await book(t.db, co.companyId, ana.id, co.pto, { startDate: "2026-12-01", status: "cancelled" });
    await book(t.db, co.companyId, ana.id, co.pto, { startDate: "2026-07-01" });
    await book(t.db, co.companyId, ana.id, co.pto, { startDate: "2028-06-01" });
    await book(t.db, co.companyId, ben.id, co.pto, { startDate: "2026-11-24" });

    const { token } = await issueCalendarFeed(ctx, ana, "personal");
    const feed = await renderCalendarFeed(ctx, token);
    assert.ok(feed);
    assert.equal(feed.kind, "personal");
    const vcal = parseIcs(feed.body);
    assert.equal(only(vcal, "X-WR-CALNAME").value, "OOOhm: My time off");
    assert.equal(only(vcal, "METHOD").value, "PUBLISH");
    assert.deepEqual(eventsOf(feed.body), [
      // Ends inside the window, so it is still shown.
      [`${early.id}@ooohm`, "PTO", "CONFIRMED", "20260801", "20260804"],
      [`${week.id}@ooohm`, "PTO", "CONFIRMED", "20261123", "20261128"],
      [`${half.id}@ooohm`, "PTO (PM, pending)", "TENTATIVE", "20261231", "20270101"],
    ]);
    assert.ok(!feed.body.includes("SECRET"), "never a note, even in my own feed");
  });

  test("a team feed: everyone active in the company, by name, and never a note", async () => {
    const co = await seedCompany(t.db, { ana: {}, ben: {}, cy: {} });
    const { ana, ben, cy } = co.people;
    const other = await seedCompany(t.db, { stranger: {} });
    const ctx = createTestContext(t.db);
    const a = await book(t.db, co.companyId, ana.id, co.pto, { startDate: "2026-11-02", dayPortion: "am", note: "SECRET-ANA", decisionNote: "SECRET-OK" });
    const b = await book(t.db, co.companyId, ben.id, co.pto, { startDate: "2026-11-03", status: "pending", note: "SECRET-BEN" });
    await book(t.db, co.companyId, cy.id, co.pto, { startDate: "2026-11-04", note: "SECRET-CY" });
    await book(t.db, other.companyId, other.people.stranger.id, other.pto, { startDate: "2026-11-02" });
    await t.db.update(schema.user).set({ isActive: false }).where(eq(schema.user.id, cy.id));
    await t.db.update(schema.companies).set({ name: "Smith, Jones; Co" }).where(eq(schema.companies.id, co.companyId));

    const { token } = await issueCalendarFeed(ctx, ben, "team");
    const feed = await renderCalendarFeed(ctx, token);
    assert.ok(feed);
    assert.equal(unescapeText(only(parseIcs(feed.body), "X-WR-CALNAME").value), "OOOhm: Who's out at Smith, Jones; Co");
    assert.deepEqual(eventsOf(feed.body), [
      [`${a.id}@ooohm`, "Ana: PTO (AM)", "CONFIRMED", "20261102", "20261103"],
      [`${b.id}@ooohm`, "Ben: PTO (pending)", "TENTATIVE", "20261103", "20261104"],
    ]);
    assert.deepEqual(
      parseIcs(feed.body).components.map((e) => only(e, "TRANSP").value),
      ["TRANSPARENT", "TRANSPARENT"],
    );
    assert.ok(!feed.body.includes("SECRET"), "no note or decision note");
  });

  test("getting a new link revokes the old one in the same step; turning off stops the feed", async () => {
    const co = await seedCompany(t.db, { ana: {} });
    const { ana } = co.people;
    const ctx = createTestContext(t.db);

    const first = await issueCalendarFeed(ctx, ana, "team");
    const second = await issueCalendarFeed(ctx, ana, "team");
    assert.notEqual(first.token, second.token);
    assert.equal(await renderCalendarFeed(ctx, first.token), null, "the old link is dead");
    assert.ok(await renderCalendarFeed(ctx, second.token));

    const live = await t.db
      .select()
      .from(schema.calendarFeedTokens)
      .where(and(eq(schema.calendarFeedTokens.userId, ana.id), sql`${schema.calendarFeedTokens.revokedAt} is null`));
    assert.deepEqual(live.map((r) => r.tokenHash), [sha256(second.token)]);

    // A personal feed is separate from the team feed.
    const personal = await issueCalendarFeed(ctx, ana, "personal");

    assert.equal(await revokeCalendarFeed(ctx, ana, "team"), true);
    assert.equal(await renderCalendarFeed(ctx, second.token), null);
    assert.ok(await renderCalendarFeed(ctx, personal.token), "turning off one kind leaves the other");
    assert.equal(await revokeCalendarFeed(ctx, ana, "team"), false, "nothing left to turn off");

    const audit = await feedAudit(t.db, co.companyId);
    assert.deepEqual(
      audit.map((a) => [a.action, (a.after as { kind: string }).kind, (a.after as { revokedAt: string | null }).revokedAt !== null]),
      [
        ["calendar_feed.issued", "team", false],
        ["calendar_feed.revoked", "team", true],
        ["calendar_feed.issued", "team", false],
        ["calendar_feed.issued", "personal", false],
        ["calendar_feed.revoked", "team", true],
      ],
      "the no-op revoke records nothing",
    );
    const events = await feedEvents(t.db, co.companyId);
    assert.deepEqual(
      events.map((e) => [e.type, (e.payload as { reason: string | null }).reason]),
      [
        ["calendar_feed.issued", null],
        ["calendar_feed.revoked", "regenerated"],
        ["calendar_feed.issued", null],
        ["calendar_feed.issued", null],
        ["calendar_feed.revoked", "turned_off"],
      ],
    );
    const { feeds } = await listCalendarFeeds(ctx, ana);
    assert.equal(feeds.team, null);
    assert.ok(feeds.personal);
  });

  test("two link requests at once leave exactly one live link, and it is the one that works", async () => {
    const co = await seedCompany(t.db, { ana: {} });
    const ctx = createTestContext(t.db);
    const results = await Promise.all([1, 2, 3].map(() => issueCalendarFeed(ctx, co.people.ana, "personal")));
    const working = [];
    for (const r of results) if (await renderCalendarFeed(ctx, r.token)) working.push(r.token);
    assert.equal(working.length, 1);
    const live = await t.db
      .select()
      .from(schema.calendarFeedTokens)
      .where(and(eq(schema.calendarFeedTokens.userId, co.people.ana.id), sql`${schema.calendarFeedTokens.revokedAt} is null`));
    assert.deepEqual(live.map((r) => r.tokenHash), [sha256(working[0])]);
  });

  test("unknown, malformed, deactivated and moved-away links all answer nothing; malformed ones never query", async () => {
    const co = await seedCompany(t.db, { ana: {}, ben: {} });
    const ctx = createTestContext(t.db);
    const { token } = await issueCalendarFeed(ctx, co.people.ana, "team");
    const { token: benToken } = await issueCalendarFeed(ctx, co.people.ben, "personal");

    let queries = 0;
    const counting = drizzle(t.client, { schema, casing: "snake_case", logger: { logQuery: () => void queries++ } });
    const countingCtx = createTestContext(counting);
    for (const bad of ["", "short", `${token}x`, token.replace(/.$/, "+"), "../../etc/passwd"]) {
      assert.equal(await renderCalendarFeed(countingCtx, bad), null, bad);
    }
    assert.equal(queries, 0, "malformed tokens are refused before any query");
    assert.equal(await renderCalendarFeed(countingCtx, token.replace(/^./, (c) => (c === "A" ? "B" : "A"))), null, "unknown");
    assert.equal(queries, 1, "an unknown token costs one indexed lookup");

    await t.db.update(schema.user).set({ isActive: false }).where(eq(schema.user.id, co.people.ana.id));
    assert.equal(await renderCalendarFeed(ctx, token), null, "deactivated owner");
    await rejectsWith(issueCalendarFeed(ctx, co.people.ana, "team"), "forbidden");

    const elsewhere = await seedCompany(t.db, {});
    await t.db.update(schema.user).set({ companyId: elsewhere.companyId }).where(eq(schema.user.id, co.people.ben.id));
    assert.equal(await renderCalendarFeed(ctx, benToken), null, "owner moved to another company");
  });

  test("last use is stamped on fetch, at most hourly; rendering is two queries, three when the stamp is due", async () => {
    const co = await seedCompany(t.db, { ana: {} });
    const ctx = createTestContext(t.db);
    const { token } = await issueCalendarFeed(ctx, co.people.ana, "team");
    const stamp = async () => {
      const [row] = await t.db.select().from(schema.calendarFeedTokens).where(eq(schema.calendarFeedTokens.tokenHash, sha256(token)));
      return row.lastUsedAt;
    };
    let queries = 0;
    const counting = drizzle(t.client, { schema, casing: "snake_case", logger: { logQuery: () => void queries++ } });
    const render = async () => {
      queries = 0;
      const feed = await renderCalendarFeed(createTestContext(counting), token);
      return { feed, queries };
    };

    assert.equal((await render()).queries, 3, "never used: lookup, then entries and the stamp");
    const first = await stamp();
    assert.deepEqual(first, ctx.now(), "stamped with the service clock");

    assert.equal((await render()).queries, 2, "used within the hour: no UPDATE at all");
    assert.deepEqual(await stamp(), first);

    const twoHoursAgo = new Date(first!.getTime() - 2 * 3_600_000);
    await t.db.update(schema.calendarFeedTokens).set({ lastUsedAt: twoHoursAgo }).where(eq(schema.calendarFeedTokens.tokenHash, sha256(token)));
    assert.equal((await render()).queries, 3, "over an hour old: stamped again");
    assert.deepEqual(await stamp(), first);

    // More people and requests do not add queries.
    const extra = Array.from({ length: 20 }, () => ({ id: randomUUID(), name: "X", email: `x-${randomUUID()}@example.com`, companyId: co.companyId }));
    await t.db.insert(schema.user).values(extra);
    for (const p of extra) await book(t.db, co.companyId, p.id, co.pto, { startDate: "2026-11-05" });
    const busy = await render();
    assert.equal(busy.queries, 2);
    assert.equal(parseIcs(busy.feed!.body).components.length, 20);
  });

  test("a refused admit stops after the lookup with rate_limited, and is asked with the feed's id", async () => {
    const co = await seedCompany(t.db, { ana: {} });
    const ctx = createTestContext(t.db);
    const { token } = await issueCalendarFeed(ctx, co.people.ana, "personal");
    const [row] = await t.db.select().from(schema.calendarFeedTokens).where(eq(schema.calendarFeedTokens.tokenHash, sha256(token)));

    let queries = 0;
    const counting = drizzle(t.client, { schema, casing: "snake_case", logger: { logQuery: () => void queries++ } });
    const asked: string[] = [];
    await rejectsWith(
      renderCalendarFeed(createTestContext(counting), token, { admit: (id) => (asked.push(id), false) }),
      "rate_limited",
    );
    assert.deepEqual(asked, [row.id]);
    assert.equal(queries, 1, "only the lookup ran");
    const [refused] = await t.db.select().from(schema.calendarFeedTokens).where(eq(schema.calendarFeedTokens.id, row.id));
    assert.equal(refused.lastUsedAt, null, "a refused fetch is not a use");

    const admitted = await renderCalendarFeed(ctx, token, { admit: () => true });
    assert.ok(admitted);
    asked.length = 0;
    assert.equal(await renderCalendarFeed(ctx, sha256("x").slice(0, 43), { admit: (id) => (asked.push(id), true) }), null);
    assert.deepEqual(asked, [], "an unknown token never reaches admit");
  });

  test("after a company move the old link can be seen, replaced and turned off, and moving back never revives it", async () => {
    const a = await seedCompany(t.db, { ben: {} });
    const b = await seedCompany(t.db, {});
    const ctx = createTestContext(t.db);
    const benInA = a.people.ben;
    const old = await issueCalendarFeed(ctx, benInA, "team");
    const oldPersonal = await issueCalendarFeed(ctx, benInA, "personal");
    const [oldRow] = await t.db.select().from(schema.calendarFeedTokens).where(eq(schema.calendarFeedTokens.tokenHash, sha256(old.token)));

    const moveTo = (companyId: string) => t.db.update(schema.user).set({ companyId }).where(eq(schema.user.id, benInA.id));
    await moveTo(b.companyId);
    const benInB = { ...benInA, companyId: b.companyId };
    assert.equal(await renderCalendarFeed(ctx, old.token), null, "dead while he is elsewhere");

    const listed = await listCalendarFeeds(ctx, benInB);
    assert.deepEqual(listed.feeds.team, { createdAt: oldRow.createdAt, lastUsedAt: null }, "he can see the old link");

    const fresh = await issueCalendarFeed(ctx, benInB, "team");
    assert.ok(await renderCalendarFeed(ctx, fresh.token), "a new link in the new company works");
    const rows = await t.db.select().from(schema.calendarFeedTokens).where(eq(schema.calendarFeedTokens.userId, benInA.id));
    const byHash = new Map(rows.map((r) => [r.tokenHash, r]));
    assert.ok(byHash.get(sha256(old.token))!.revokedAt, "the old link was revoked");
    assert.equal(byHash.get(sha256(fresh.token))!.companyId, b.companyId);

    assert.equal(await revokeCalendarFeed(ctx, benInB, "personal"), true, "the old personal link can be turned off from B");

    // Each revoke is recorded in the company the link belonged to.
    assert.deepEqual(
      (await feedAudit(t.db, a.companyId)).map((r) => [r.action, (r.after as { kind: string }).kind]),
      [
        ["calendar_feed.issued", "team"],
        ["calendar_feed.issued", "personal"],
        ["calendar_feed.revoked", "team"],
        ["calendar_feed.revoked", "personal"],
      ],
    );
    assert.deepEqual(
      (await feedEvents(t.db, a.companyId)).map((e) => [e.type, (e.payload as { reason: string | null }).reason]),
      [
        ["calendar_feed.issued", null],
        ["calendar_feed.issued", null],
        ["calendar_feed.revoked", "regenerated"],
        ["calendar_feed.revoked", "turned_off"],
      ],
    );
    assert.deepEqual((await feedAudit(t.db, b.companyId)).map((r) => r.action), ["calendar_feed.issued"]);

    await moveTo(a.companyId);
    assert.equal(await renderCalendarFeed(ctx, old.token), null, "moving back does not revive the old team link");
    assert.equal(await renderCalendarFeed(ctx, oldPersonal.token), null, "nor the old personal one");
  });

  test("unknown feed kinds are refused", async () => {
    const co = await seedCompany(t.db, { ana: {} });
    const ctx = createTestContext(t.db);
    await rejectsWith(issueCalendarFeed(ctx, co.people.ana, "everyone" as never), "invalid_input");
    await rejectsWith(revokeCalendarFeed(ctx, co.people.ana, "everyone" as never), "invalid_input");
  });
});
