import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor } from "@/shared/kernel/actor";
import type { FeedKind } from "@/shared/kernel/calendar-feed";
import type { ServiceContext } from "@/server/context";
import { calendarFilterParamSchema, issueCalendarFeed, monthParamSchema, renderCalendarFeed, revokeCalendarFeed } from "@/modules/calendar";

/** A context with no database: any read throws, so these prove a check runs before I/O. */
const ctx = new Proxy({} as ServiceContext, {
  get(_target, key) {
    throw new Error(`ctx.${String(key)} was read`);
  },
});
const actor = { id: "u-1", companyId: "c-1", role: "employee" } as Actor;

describe("feed use cases refuse an unknown kind before any I/O", () => {
  for (const [name, call] of Object.entries({ issueCalendarFeed, revokeCalendarFeed })) {
    test(name, async () => {
      const result = await call(ctx, actor, "everyone" as FeedKind);
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.error.code, "invalid_input");
    });
  }
});

describe("renderCalendarFeed", () => {
  test("a malformed token renders nothing, without a lookup and without saying why", async () => {
    for (const token of ["", "short", "x".repeat(200), "not a token!"]) {
      const result = await renderCalendarFeed(ctx, token);
      assert.deepEqual(result.ok && result.value, null);
    }
  });
});

describe("calendar params", () => {
  test("a month is YYYY-MM", () => {
    assert.equal(monthParamSchema.safeParse("2026-07").success, true);
    assert.equal(monthParamSchema.safeParse("2026-13").success, false);
    assert.equal(monthParamSchema.safeParse("July").success, false);
  });

  test("the calendar filter is me, team or everyone", () => {
    assert.deepEqual(["me", "team", "everyone"].map((f) => calendarFilterParamSchema.safeParse(f).success), [true, true, true]);
    assert.equal(calendarFilterParamSchema.safeParse("admins").success, false);
  });
});
