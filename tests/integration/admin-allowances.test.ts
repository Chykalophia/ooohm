import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { sql } from "drizzle-orm";
import { setAllowanceOverride } from "@/server/services/admin-allowances";
import { getPersonDetail } from "@/server/services/admin-people";
import { submitLeaveRequest } from "@/server/services/leave-requests";
import { runYearRollover } from "@/server/services/rollover";
import { rejectsWith } from "./assertions";
import { addLeaveType, allowancesOf, companyAudit, companyEvents, seedCompany, setAllowance } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

describe("admin: allowance overrides", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  test("an override sets days and adjustment, keeps carried-over days, and records the reason in the audit only", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: {} });
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 15, carryoverEnabled: true });
    await setAllowance(t.db, { userId: co.people.ana.id, leaveTypeId: vac, year: 2026, days: 15, carriedOverDays: 3 });
    const ctx = createTestContext(t.db);

    const { row, changed } = await setAllowanceOverride(ctx, co.people.boss, {
      userId: co.people.ana.id,
      leaveTypeId: vac,
      year: 2026,
      days: 20,
      adjustmentDays: -1.5,
      reason: " Promotion ",
    });
    assert.equal(changed, true);
    assert.deepEqual([row.days, row.carriedOverDays, row.adjustmentDays], [20, 3, -1.5]);
    // Same values again: nothing written or recorded, and the caller is told so.
    const again = await setAllowanceOverride(ctx, co.people.boss, { userId: co.people.ana.id, leaveTypeId: vac, year: 2026, days: 20, adjustmentDays: -1.5, reason: "again" });
    assert.equal(again.changed, false, "a no-op is reported as one, not as a save");
    assert.equal(again.row.id, row.id);

    const audit = await companyAudit(t.db, co.companyId);
    assert.deepEqual(
      audit.map((a) => [a.action, a.actorId, a.entityId, a.subjectUserId]),
      [["allowance.edited", co.people.boss.id, row.id, co.people.ana.id]],
    );
    assert.deepEqual(audit[0].before, { userId: co.people.ana.id, leaveTypeId: vac, year: 2026, days: 15, carriedOverDays: 3, adjustmentDays: 0 });
    assert.deepEqual(audit[0].after, {
      userId: co.people.ana.id,
      leaveTypeId: vac,
      year: 2026,
      days: 20,
      carriedOverDays: 3,
      adjustmentDays: -1.5,
      reason: "Promotion",
    });
    const events = await companyEvents(t.db, co.companyId);
    assert.deepEqual(events.map((e) => [e.type, e.payload]), [
      [
        "balance.adjusted",
        {
          allowanceId: row.id,
          userId: co.people.ana.id,
          leaveTypeId: vac,
          year: 2026,
          days: 20,
          carriedOverDays: 3,
          adjustmentDays: -1.5,
          reason: "admin_edit",
          actorId: co.people.boss.id,
          actor: { type: "user", id: co.people.boss.id },
        },
      ],
    ]);

    const { balances } = await getPersonDetail(ctx, co.people.boss, co.people.ana.id, 2026);
    const vacBalance = balances?.items.find((i) => i.leaveTypeId === vac)?.balance;
    assert.ok(vacBalance?.tracked);
    assert.deepEqual([vacBalance.total, vacBalance.remaining], [21.5, 21.5], "20 + 3 carried - 1.5 adjusted");
  });

  test("an override for a year without a row creates one with nothing carried; the rollover keeps the admin's values", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { createdAt: "2025-01-01T00:00:00Z" } });
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 10, carryoverEnabled: true });
    await setAllowance(t.db, { userId: co.people.ana.id, leaveTypeId: vac, year: 2025, days: 10 });
    const ctx = createTestContext(t.db);
    await setAllowanceOverride(ctx, co.people.boss, { userId: co.people.ana.id, leaveTypeId: vac, year: 2026, days: 12, adjustmentDays: 1, reason: "Raise" });
    await runYearRollover(createTestContext(t.db, { now: new Date("2026-11-01T15:00:00Z") }), 2025);
    const vac2026 = (await allowancesOf(t.db, co.people.ana.id)).find((r) => r.leaveTypeId === vac && r.year === 2026);
    assert.deepEqual(vac2026, { leaveTypeId: vac, year: 2026, days: 12, carriedOverDays: 10, adjustmentDays: 1 }, "the rollover set only the carry");
  });

  test("editing last year re-carries into this year at once, as the rollover would", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { createdAt: "2024-06-01T00:00:00Z" } });
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 10, carryoverEnabled: true, carryoverMaxDays: 20 });
    await setAllowance(t.db, { userId: co.people.ana.id, leaveTypeId: vac, year: 2025, days: 10 });
    const ctx = createTestContext(t.db);
    await runYearRollover(ctx, 2025);
    const carried = async () =>
      (await allowancesOf(t.db, co.people.ana.id)).find((r) => r.leaveTypeId === vac && r.year === 2026)?.carriedOverDays;
    assert.equal(await carried(), 10, "the rollover carried all 10 unused days");

    await setAllowanceOverride(ctx, co.people.boss, { userId: co.people.ana.id, leaveTypeId: vac, year: 2025, days: 4, adjustmentDays: 0, reason: "Was wrong" });
    assert.equal(await carried(), 4, "2026's carry follows the edit without another rollover run");
    const detail2025 = await getPersonDetail(ctx, co.people.boss, co.people.ana.id, 2025);
    const vac2025 = detail2025.balances?.items.find((i) => i.leaveTypeId === vac)?.balance;
    assert.ok(vac2025?.tracked);
    assert.equal(vac2025.remaining, 0, "4 granted, 4 carried out: nothing left, not -6");
    const vac2026 = (await getPersonDetail(ctx, co.people.boss, co.people.ana.id, 2026)).balances?.items.find((i) => i.leaveTypeId === vac)?.balance;
    assert.ok(vac2026?.tracked);
    assert.equal(vac2026.remaining, 14, "10 default + 4 carried");
    assert.equal(detail2025.firstEditableYear, 2025);

    // The re-carry is the admin's edit at work, not the nightly process: it names them too.
    const actions = (await companyAudit(t.db, co.companyId, "allowance.")).map((a) => [a.action, a.actorKind, a.actorId, a.actorProcess]);
    assert.deepEqual(actions.slice(-2), [
      ["allowance.edited", "user", co.people.boss.id, null],
      ["allowance.carried_over", "user", co.people.boss.id, null],
    ]);
    const events = (await companyEvents(t.db, co.companyId)).map((e) => (e.payload as { reason: string }).reason);
    assert.deepEqual(events.slice(-2), ["admin_edit", "carryover"], "each change has its outbox row");

    // A rerun of the rollover now agrees and changes nothing for this person.
    const auditRows = (await companyAudit(t.db, co.companyId)).length;
    await runYearRollover(ctx, 2025);
    assert.equal(await carried(), 4);
    assert.equal((await companyAudit(t.db, co.companyId)).length, auditRows);
  });

  test("editing this year leaves next year's carry to the rollover", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: {} });
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 10, carryoverEnabled: true });
    const ctx = createTestContext(t.db);
    await setAllowanceOverride(ctx, co.people.boss, { userId: co.people.ana.id, leaveTypeId: vac, year: 2026, days: 4, adjustmentDays: 0, reason: "r" });
    assert.deepEqual(
      (await allowancesOf(t.db, co.people.ana.id)).map((r) => [r.year, r.days, r.carriedOverDays]),
      [[2026, 4, 0]],
      "no 2027 row: 2026 has not ended",
    );
  });

  test("lowering an allowance below what is booked is allowed and shows as negative remaining", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { canSelfApprove: true } });
    await setAllowance(t.db, { userId: co.people.ana.id, leaveTypeId: co.pto, year: 2026, days: 10 });
    const ctx = createTestContext(t.db);
    await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-16", endDate: "2026-11-20", dayPortion: "full" });
    await setAllowanceOverride(ctx, co.people.boss, { userId: co.people.ana.id, leaveTypeId: co.pto, year: 2026, days: 3, adjustmentDays: 0, reason: "Correction" });
    const { balances } = await getPersonDetail(ctx, co.people.boss, co.people.ana.id, 2026);
    const pto = balances?.items.find((i) => i.leaveTypeId === co.pto)?.balance;
    assert.ok(pto?.tracked);
    assert.equal(pto.remaining, -2);
  });

  test("an override waits for the person's in-flight submit (member lock), so it never interleaves with one", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { canSelfApprove: true } });
    await setAllowance(t.db, { userId: co.people.ana.id, leaveTypeId: co.pto, year: 2026, days: 10 });
    const ctx = createTestContext(t.db);
    const order: string[] = [];
    let releaseLock!: () => void;
    const held = new Promise<void>((resolve) => (releaseLock = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    // Hold Ana's member lock the way submit does, then see the override queue behind it.
    const holder = t.db.transaction(async (tx) => {
      await tx.execute(sql`select id from "user" where id = ${co.people.ana.id} for no key update`);
      locked();
      await held;
      order.push("holder done");
    });
    await isLocked;
    const override = setAllowanceOverride(ctx, co.people.boss, {
      userId: co.people.ana.id,
      leaveTypeId: co.pto,
      year: 2026,
      days: 4,
      adjustmentDays: 0,
      reason: "x",
    }).then(() => order.push("override done"));
    await new Promise((r) => setTimeout(r, 100));
    const blocked = [...order];
    // Release before asserting, so a failure here cannot leave the transaction open.
    releaseLock();
    await Promise.all([holder, override]);
    assert.deepEqual(blocked, [], "the override is blocked by the lock");
    assert.deepEqual(order, ["holder done", "override done"]);
  });

  test("only admins, only within their company, only valid amounts and a reason", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, mgr: { role: "manager" }, ana: {} });
    const other = await seedCompany(t.db, { x: {} });
    const ctx = createTestContext(t.db);
    const base = { userId: co.people.ana.id, leaveTypeId: co.pto, year: 2026, days: 5, adjustmentDays: 0, reason: "r" };
    await rejectsWith(setAllowanceOverride(ctx, co.people.mgr, base), "forbidden");
    await rejectsWith(setAllowanceOverride(ctx, co.people.boss, { ...base, userId: other.people.x.id }), "not_found");
    await rejectsWith(setAllowanceOverride(ctx, co.people.boss, { ...base, leaveTypeId: other.pto }), "not_found");
    await rejectsWith(setAllowanceOverride(ctx, co.people.boss, { ...base, reason: " " }), "invalid_input");
    await rejectsWith(setAllowanceOverride(ctx, co.people.boss, { ...base, days: -1 }), "invalid_input");
    await rejectsWith(setAllowanceOverride(ctx, co.people.boss, { ...base, days: 1.25 }), "invalid_input");
    await rejectsWith(setAllowanceOverride(ctx, co.people.boss, { ...base, year: 1999 }), "invalid_input");
    await rejectsWith(setAllowanceOverride(ctx, co.people.boss, { ...base, year: 2024 }), "invalid_input");
    assert.deepEqual(await companyAudit(t.db, co.companyId), []);
    assert.deepEqual(await allowancesOf(t.db, co.people.ana.id), []);
  });
});
