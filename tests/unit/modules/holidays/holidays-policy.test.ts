import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor } from "@/domain/actor";
import type { ServiceContext } from "@/server/context";
import {
  addHoliday,
  addHolidayRange,
  addUsFederalHolidays,
  canManageHolidays,
  deleteHoliday,
  deleteHolidays,
  listHolidaysForAdmin,
  renameHoliday,
  renameHolidays,
} from "@/modules/holidays";

describe("canManageHolidays", () => {
  test("admins may", () => {
    assert.equal(canManageHolidays({ role: "admin" }), true);
  });

  test("managers and employees may not", () => {
    assert.equal(canManageHolidays({ role: "manager" }), false);
    assert.equal(canManageHolidays({ role: "employee" }), false);
  });
});

/**
 * Every holiday use case asks the policy first and fails with `forbidden` before it
 * touches the database: the context here has none, so any read would throw.
 */
describe("the holiday use cases refuse a non-admin before any I/O", () => {
  const ctx = new Proxy({} as ServiceContext, {
    get(_target, key) {
      throw new Error(`ctx.${String(key)} was read`);
    },
  });
  const manager = { id: "u-1", companyId: "c-1", role: "manager" } as Actor;
  const id = "00000000-0000-4000-8000-000000000000";
  const calls = {
    listHolidaysForAdmin: () => listHolidaysForAdmin(ctx, manager, 2026),
    addHoliday: () => addHoliday(ctx, manager, { date: "2026-12-25", name: "Christmas" }),
    addHolidayRange: () => addHolidayRange(ctx, manager, { startDate: "2026-12-24", endDate: "2026-12-31", name: "Break" }),
    addUsFederalHolidays: () => addUsFederalHolidays(ctx, manager, 2026),
    renameHoliday: () => renameHoliday(ctx, manager, id, "Eve"),
    renameHolidays: () => renameHolidays(ctx, manager, [id], "Eve"),
    deleteHoliday: () => deleteHoliday(ctx, manager, id),
    deleteHolidays: () => deleteHolidays(ctx, manager, [id]),
  };
  for (const [name, call] of Object.entries(calls)) {
    test(name, async () => {
      const result = await call();
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.error.code, "forbidden");
    });
  }
});

describe("invalid input fails as a result, not a throw", () => {
  const ctx = {} as ServiceContext;
  const admin = { id: "u-1", companyId: "c-1", role: "admin" } as Actor;
  const failsWith = async (promise: Promise<{ ok: boolean; error?: { code: string } }>, code: string) => {
    const result = await promise;
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, code);
  };

  test("a date that isn't real, a year out of range, a blank name", async () => {
    await failsWith(addHoliday(ctx, admin, { date: "2026-02-30", name: "Nope" }), "invalid_input");
    await failsWith(addHoliday(ctx, admin, { date: "1999-12-31", name: "Old" }), "invalid_input");
    await failsWith(addHoliday(ctx, admin, { date: "2026-12-25", name: "   " }), "invalid_input");
    await failsWith(addUsFederalHolidays(ctx, admin, 2101), "invalid_input");
    await failsWith(listHolidaysForAdmin(ctx, admin, 1999), "invalid_input");
  });

  test("a run ending before it starts, or longer than allowed", async () => {
    await failsWith(addHolidayRange(ctx, admin, { startDate: "2026-12-26", endDate: "2026-12-24", name: "Back" }), "invalid_input");
    await failsWith(addHolidayRange(ctx, admin, { startDate: "2026-01-01", endDate: "2026-03-01", name: "Long" }), "invalid_input");
  });

  test("ids that aren't ids are not found", async () => {
    await failsWith(renameHolidays(ctx, admin, [], "Eve"), "not_found");
    await failsWith(deleteHolidays(ctx, admin, ["nope"]), "not_found");
    await failsWith(deleteHoliday(ctx, admin, "nope"), "not_found");
  });
});
