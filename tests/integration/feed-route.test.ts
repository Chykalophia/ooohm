import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createRateLimiter } from "@/lib/rate-limit";
import { issueCalendarFeed, revokeCalendarFeed } from "@/server/services/calendar-feeds";
import {
  FETCHES_PER_FEED_PER_MINUTE,
  type FeedLimits,
  handleFeedFetch,
  MISSES_PER_MINUTE,
} from "@/app/api/ics/[file]/feed-fetch";
import { parseIcs } from "../support/ics-parser";
import { seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

/** Fresh limits on an injected clock, as the route builds them. */
function limitsAt(clock: { now: number }): FeedLimits {
  const now = () => clock.now;
  return {
    misses: createRateLimiter({ limit: MISSES_PER_MINUTE, windowMs: 60_000, now }),
    perFeed: createRateLimiter({ limit: FETCHES_PER_FEED_PER_MINUTE, windowMs: 60_000, now }),
  };
}

const BARE_404 = { status: 404, type: "text/plain; charset=utf-8", cache: "no-store", body: "Not found" };

async function shape(res: Response) {
  return { status: res.status, type: res.headers.get("content-type"), cache: res.headers.get("cache-control"), body: await res.text() };
}

describe("ICS feed route", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  test("a live link answers 200 with a parseable calendar and the documented headers", async () => {
    const co = await seedCompany(t.db, { ana: {} });
    const ctx = createTestContext(t.db);
    const { token } = await issueCalendarFeed(ctx, co.people.ana, "personal");

    const res = await handleFeedFetch({ ctx, file: `${token}.ics`, client: "198.51.100.1", limits: limitsAt({ now: 0 }) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/calendar; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "private, max-age=300");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const body = await res.text();
    assert.ok(body.startsWith("BEGIN:VCALENDAR\r\n"));
    assert.equal(parseIcs(body).components.length, 0);
  });

  test("malformed, unknown, revoked and deactivated links all get the same bare 404; malformed ones never query", async () => {
    const co = await seedCompany(t.db, { ana: {}, ben: {} });
    const ctx = createTestContext(t.db);
    const revoked = await issueCalendarFeed(ctx, co.people.ana, "team");
    await revokeCalendarFeed(ctx, co.people.ana, "team");
    const deactivated = await issueCalendarFeed(ctx, co.people.ben, "team");
    await t.db.update(schema.user).set({ isActive: false }).where(eq(schema.user.id, co.people.ben.id));

    let queries = 0;
    const counting = t.withLogger({ logQuery: () => void queries++ });
    const countingCtx = createTestContext(counting);
    const limits = limitsAt({ now: 0 });
    const fetch = (file: string) => handleFeedFetch({ ctx: countingCtx, file, client: "198.51.100.2", limits });

    for (const file of ["foo.txt", `${revoked.token}.txt`, "short.ics", ".ics", `${revoked.token}x.ics`]) {
      assert.deepEqual(await shape(await fetch(file)), BARE_404, file);
    }
    assert.equal(queries, 0, "malformed names are refused before any query");

    const unknown = revoked.token.replace(/^./, (c) => (c === "A" ? "B" : "A"));
    for (const token of [unknown, revoked.token, deactivated.token]) {
      assert.deepEqual(await shape(await fetch(`${token}.ics`)), BARE_404, token.slice(0, 4));
    }
  });

  test("a link fetched too often gets 429 with Retry-After, without touching another link, until the window passes", async () => {
    const co = await seedCompany(t.db, { ana: {}, ben: {} });
    const ctx = createTestContext(t.db);
    const ana = await issueCalendarFeed(ctx, co.people.ana, "personal");
    const ben = await issueCalendarFeed(ctx, co.people.ben, "personal");
    const clock = { now: 0 };
    const limits = limitsAt(clock);
    // Different clients, so only the per-link limit is in play.
    const fetch = (token: string, client: string) => handleFeedFetch({ ctx, file: `${token}.ics`, client, limits });

    for (let i = 1; i <= FETCHES_PER_FEED_PER_MINUTE; i++) {
      clock.now = i * 100;
      assert.equal((await fetch(ana.token, `203.0.113.${i}`)).status, 200, `fetch ${i}`);
    }
    clock.now = 59_999;
    const limited = await fetch(ana.token, "203.0.113.200");
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    assert.equal(limited.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.ok(!(await limited.text()).includes("BEGIN:VCALENDAR"));

    assert.equal((await fetch(ben.token, "203.0.113.200")).status, 200, "another link is unaffected");

    clock.now = 60_100; // a minute after the window's first fetch
    assert.equal((await fetch(ana.token, "203.0.113.1")).status, 200, "the next window starts over");
  });

  test("a client over its miss budget gets 429 for misses, but every live link from that same address is still served", async () => {
    const co = await seedCompany(t.db, { ana: {} });
    const ctx = createTestContext(t.db);
    const ana = await issueCalendarFeed(ctx, co.people.ana, "team");

    let queries = 0;
    const counting = t.withLogger({ logQuery: () => void queries++ });
    const countingCtx = createTestContext(counting);
    const clock = { now: 0 };
    const limits = limitsAt(clock);
    // One address for guesses and real fetches alike: the shared bucket, or a calendar
    // fetcher's address someone else is spending.
    const client = "192.0.2.66";
    const guess = (i: number) => handleFeedFetch({ ctx: countingCtx, file: `${String(i).padStart(43, "A")}.ics`, client, limits });
    const real = () => handleFeedFetch({ ctx, file: `${ana.token}.ics`, client, limits });

    for (let i = 0; i < MISSES_PER_MINUTE; i++) assert.equal((await guess(i)).status, 404);
    assert.equal(queries, MISSES_PER_MINUTE, "one lookup per miss");
    queries = 0;
    const cut = await guess(MISSES_PER_MINUTE);
    assert.equal(cut.status, 429);
    assert.equal(cut.headers.get("retry-after"), "60");
    assert.equal(queries, 1, "over budget, a miss still costs only its one index probe");
    const elsewhere = await handleFeedFetch({ ctx, file: `${"B".repeat(43)}.ics`, client: "192.0.2.7", limits });
    assert.equal(elsewhere.status, 404, "another address keeps its own miss budget");

    const live = await real();
    assert.equal(live.status, 200, "an exhausted miss budget never refuses a live link");
    assert.ok((await live.text()).startsWith("BEGIN:VCALENDAR"));
    assert.equal((await guess(MISSES_PER_MINUTE + 1)).status, 429, "serving a live link restores no miss budget");

    // Hits never spend the miss budget: a shared address (e.g. Google's fetcher) polling
    // many real links is not throttled by its own volume.
    for (let i = 0; i < MISSES_PER_MINUTE + 5; i++) {
      clock.now = 1 + i;
      limits.perFeed = createRateLimiter({ limit: FETCHES_PER_FEED_PER_MINUTE, windowMs: 60_000, now: () => clock.now });
      assert.equal((await handleFeedFetch({ ctx, file: `${ana.token}.ics`, client: "192.0.2.8", limits })).status, 200);
    }
    assert.equal((await guess(0)).status, 429, "still the same window for the guessing address");

    clock.now = 60_000;
    assert.equal((await guess(0)).status, 404, "the next window starts over");
  });
});
