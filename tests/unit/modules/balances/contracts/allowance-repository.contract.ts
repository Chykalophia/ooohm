import assert from "node:assert/strict";
import { test } from "node:test";
import type { AllowanceRepository } from "@/modules/balances/application/ports";
import type { Allowance } from "@/modules/balances/domain/allowance";
import type { LeaveStatus } from "@/shared/kernel/leave-range";
import { first } from "../../../../support/present";

/**
 * The people and leave types a contract case stores allowances for: they exist in the
 * store. `userId` and `otherUserId` are people of `companyId`; `foreignUserId` is a
 * person of `otherCompanyId`.
 */
export interface AllowanceContractFixture {
  companyId: string;
  otherCompanyId: string;
  userId: string;
  otherUserId: string;
  foreignUserId: string;
  leaveTypeId: string;
  otherLeaveTypeId: string;
}

/** Books `days` of one leave type in `year` for a person, as a request in `status` costing that much there. */
export type Book = (entry: { userId: string; leaveTypeId: string; year: number; days: number; status: LeaveStatus }) => Promise<void>;

export interface AllowanceContractStore {
  fixture: AllowanceContractFixture;
  /** Runs `work` against the repository inside one unit of work. */
  use<T>(work: (repo: AllowanceRepository, book: Book) => Promise<T>): Promise<T>;
}

/** The amounts and keys of rows, in a stable order, for comparing. */
const amounts = (rows: readonly Allowance[]) =>
  rows
    .map(({ userId, leaveTypeId, year, days, carriedOverDays, adjustmentDays }) => ({ userId, leaveTypeId, year, days, carriedOverDays, adjustmentDays }))
    .sort((a, b) => a.userId.localeCompare(b.userId) || a.leaveTypeId.localeCompare(b.leaveTypeId) || a.year - b.year);

/**
 * What every {@link AllowanceRepository} must do, run against the in-memory fake (in
 * `pnpm test`) and the Drizzle repository (in `pnpm test:integration`, on both drivers),
 * so the fake the use-case tests trust behaves like the database.
 */
export function allowanceRepositoryContract(name: string, make: () => Promise<AllowanceContractStore>): void {
  test(`${name}: inserts only missing rows, with nothing carried or adjusted, and finds them by person, type and year`, async () => {
    const { fixture: f, use } = await make();
    await use(async (repo) => {
      const inserted = first(await repo.insertMissing([{ userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2026, days: 20 }]));
      assert.deepEqual(amounts([inserted]), [{ userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2026, days: 20, carriedOverDays: 0, adjustmentDays: 0 }]);
      const again = await repo.insertMissing([
        { userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2026, days: 99 },
        { userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2027, days: 20, carriedOverDays: 3 },
      ]);
      assert.deepEqual(amounts(again).map((r) => [r.year, r.days, r.carriedOverDays]), [[2027, 20, 3]], "an existing row is left alone");
      assert.equal((await repo.find({ userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2026 }))?.days, 20);
      assert.equal(await repo.find({ userId: f.otherUserId, leaveTypeId: f.leaveTypeId, year: 2026 }), undefined);
      assert.deepEqual(await repo.insertMissing([]), []);
    });
  });

  test(`${name}: lists the years in scope plus each person and type's latest earlier row`, async () => {
    const { fixture: f, use } = await make();
    await use(async (repo) => {
      await repo.insertMissing([
        { userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2022, days: 10 },
        { userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2024, days: 12 },
        { userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2026, days: 15 },
        { userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2028, days: 18 },
        { userId: f.userId, leaveTypeId: f.otherLeaveTypeId, year: 2026, days: 5 },
        { userId: f.otherUserId, leaveTypeId: f.leaveTypeId, year: 2026, days: 30 },
      ]);
      const rows = await repo.list({ companyId: f.companyId, userIds: [f.userId], years: [2026, 2027], leaveTypeIds: [f.leaveTypeId] });
      assert.deepEqual(amounts(rows).map((r) => [r.year, r.days]), [[2024, 12], [2026, 15]]);
      const all = await repo.list({ companyId: f.companyId, userIds: [f.userId, f.otherUserId], years: [2026] });
      assert.equal(all.length, 4, "every type when none is named, and the latest earlier row of each");
      assert.deepEqual(await repo.list({ companyId: f.companyId, userIds: [], years: [2026] }), []);
      assert.deepEqual(await repo.list({ companyId: f.companyId, userIds: [f.userId], years: [2026], leaveTypeIds: [] }), []);
    });
  });

  test(`${name}: sums approved and pending days per person, type and year, and leaves out the rest`, async () => {
    const { fixture: f, use } = await make();
    await use(async (repo, book) => {
      await book({ userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2026, days: 2, status: "approved" });
      await book({ userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2026, days: 1.5, status: "approved" });
      await book({ userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2026, days: 0.5, status: "pending" });
      await book({ userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2026, days: 4, status: "cancelled" });
      await book({ userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2027, days: 1, status: "approved" });
      await book({ userId: f.otherUserId, leaveTypeId: f.leaveTypeId, year: 2026, days: 3, status: "rejected" });
      const sums = await repo.sumBooked({ companyId: f.companyId, userIds: [f.userId, f.otherUserId], years: [2026], leaveTypeIds: [f.leaveTypeId] });
      assert.deepEqual(sums, [{ userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2026, approved: 3.5, pending: 0.5 }]);
      assert.deepEqual(await repo.sumBooked({ companyId: f.companyId, userIds: [f.userId], years: [2026], leaveTypeIds: [f.otherLeaveTypeId] }), []);
    });
  });

  test(`${name}: lists and sums only the rows of the scope's company's people`, async () => {
    const { fixture: f, use } = await make();
    await use(async (repo, book) => {
      await repo.insertMissing([
        { userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2026, days: 15 },
        { userId: f.foreignUserId, leaveTypeId: f.leaveTypeId, year: 2026, days: 30 },
      ]);
      await book({ userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2026, days: 2, status: "approved" });
      await book({ userId: f.foreignUserId, leaveTypeId: f.leaveTypeId, year: 2026, days: 3, status: "approved" });
      const scope = { companyId: f.companyId, userIds: [f.userId, f.foreignUserId], years: [2026] };
      assert.deepEqual(amounts(await repo.list(scope)).map((r) => [r.userId, r.days]), [[f.userId, 15]]);
      assert.deepEqual((await repo.sumBooked(scope)).map((r) => [r.userId, r.approved]), [[f.userId, 2]]);
      const foreign = { companyId: f.companyId, userIds: [f.foreignUserId], years: [2026] };
      assert.deepEqual(await repo.list(foreign), [], "another company's person reads nothing");
      assert.deepEqual(await repo.sumBooked(foreign), []);
      assert.equal((await repo.list({ ...foreign, companyId: f.otherCompanyId })).length, 1, "their own company reads them");
    });
  });

  test(`${name}: an override sets days and adjustment, keeps the carry, and creates a missing row with none`, async () => {
    const { fixture: f, use } = await make();
    await use(async (repo) => {
      const row = first(await repo.insertMissing([{ userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2026, days: 20, carriedOverDays: 4 }]));
      const edited = await repo.writeOverride({ userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2026, days: 18, adjustmentDays: -1.5 });
      assert.equal(edited.id, row.id);
      assert.deepEqual([edited.days, edited.carriedOverDays, edited.adjustmentDays], [18, 4, -1.5]);
      const created = await repo.writeOverride({ userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2027, days: 22, adjustmentDays: 1 });
      assert.deepEqual([created.year, created.days, created.carriedOverDays, created.adjustmentDays], [2027, 22, 0, 1]);
    });
  });

  test(`${name}: sets carried-over days and days of one row`, async () => {
    const { fixture: f, use } = await make();
    await use(async (repo) => {
      const row = first(await repo.insertMissing([{ userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2026, days: 20 }]));
      assert.equal((await repo.setCarriedOverDays(row.id, 2.5)).carriedOverDays, 2.5);
      const after = await repo.setDays(row.id, 25);
      assert.deepEqual([after.days, after.carriedOverDays], [25, 2.5]);
      assert.equal((await repo.find({ userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2026 }))?.days, 25);
    });
  });

  test(`${name}: locks a person's rows from a year on, of the types named, by type then year`, async () => {
    const { fixture: f, use } = await make();
    await use(async (repo) => {
      await repo.insertMissing([
        { userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2027, days: 20 },
        { userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2025, days: 20 },
        { userId: f.userId, leaveTypeId: f.leaveTypeId, year: 2026, days: 20 },
        { userId: f.userId, leaveTypeId: f.otherLeaveTypeId, year: 2026, days: 5 },
      ]);
      const rows = await repo.lockFrom({ userIds: [f.userId], fromYear: 2026, leaveTypeIds: [f.leaveTypeId] });
      assert.deepEqual(rows.map((r) => r.year), [2026, 2027]);
      assert.equal((await repo.lockFrom({ userIds: [f.userId], fromYear: 2026 })).length, 3);
      assert.deepEqual(await repo.lockFrom({ userIds: [], fromYear: 2026 }), []);
    });
  });
}
