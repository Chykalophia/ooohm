import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { LeaveRequestRepository } from "@/modules/leave/application/ports";
import type { LeaveRequest } from "@/modules/leave/domain/leave-request";
import { at } from "../../../../support/present";

/** The people and leave type a contract case stores requests for: they exist in the store. */
export interface ContractFixture {
  companyId: string;
  /** A company the requests are not in. */
  otherCompanyId: string;
  userId: string;
  otherUserId: string;
  approverId: string;
  leaveTypeId: string;
  /** The leave type's name, as the own-request reads join it in. */
  leaveTypeName: string;
}

/** A fresh store for one case: its fixture, and a way to run work against the repository inside one unit of work. */
export interface ContractStore {
  fixture: ContractFixture;
  use<T>(work: (repo: LeaveRequestRepository) => Promise<T>): Promise<T>;
}

/**
 * What every {@link LeaveRequestRepository} must do, run against the in-memory fake (in
 * `pnpm test`) and the Drizzle repository (in `pnpm test:integration`, on both drivers),
 * so the fake the use-case tests trust behaves like the database.
 */
export function leaveRequestRepositoryContract(name: string, make: () => Promise<ContractStore>): void {
  const draft = (f: ContractFixture, over: Partial<LeaveRequest> = {}): LeaveRequest => ({
    id: randomUUID(),
    companyId: f.companyId,
    userId: f.userId,
    leaveTypeId: f.leaveTypeId,
    startDate: "2026-11-09",
    endDate: "2026-11-10",
    dayPortion: "full",
    days: 2,
    note: "Family visit",
    status: "pending",
    approverId: f.approverId,
    decidedAt: null,
    decisionNote: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  });

  test(`${name}: stores a request with the id it was given and finds it in its company only`, async () => {
    const { fixture: f, use } = await make();
    const request = draft(f);
    await use(async (repo) => {
      const stored = await repo.insert(request);
      assert.equal(stored.id, request.id);
      assert.deepEqual({ ...stored, createdAt: 0, updatedAt: 0 }, { ...request, createdAt: 0, updatedAt: 0 });
      assert.ok(stored.createdAt.getTime() > 0, "the store sets the timestamps");
      assert.deepEqual(await repo.find(f.companyId, request.id), stored);
      assert.deepEqual(await repo.lock(f.companyId, request.id), stored);
      assert.equal(await repo.find(f.otherCompanyId, request.id), undefined);
      assert.equal(await repo.find(f.companyId, randomUUID()), undefined);
    });
  });

  test(`${name}: overlapping reads only the requester's pending and approved requests on those dates`, async () => {
    const { fixture: f, use } = await make();
    await use(async (repo) => {
      await repo.insert(draft(f, { startDate: "2026-11-09", endDate: "2026-11-10" }));
      await repo.insert(draft(f, { startDate: "2026-11-11", endDate: "2026-11-11", dayPortion: "am", days: 0.5, status: "approved" }));
      await repo.insert(draft(f, { startDate: "2026-11-10", endDate: "2026-11-10", status: "cancelled" }));
      await repo.insert(draft(f, { userId: f.otherUserId, startDate: "2026-11-10", endDate: "2026-11-10" }));
      await repo.insert(draft(f, { startDate: "2026-11-20", endDate: "2026-11-20" }));
      const hits = await repo.findActiveOverlapping(f.userId, { startDate: "2026-11-10", endDate: "2026-11-11", dayPortion: "full" });
      assert.deepEqual(
        hits.map(({ startDate, endDate, dayPortion }) => ({ startDate, endDate, dayPortion })).sort((a, b) => a.startDate.localeCompare(b.startDate)),
        [
          { startDate: "2026-11-09", endDate: "2026-11-10", dayPortion: "full" },
          { startDate: "2026-11-11", endDate: "2026-11-11", dayPortion: "am" },
        ],
      );
    });
  });

  test(`${name}: the status changes only while it is still what the caller read`, async () => {
    const { fixture: f, use } = await make();
    await use(async (repo) => {
      const { id } = await repo.insert(draft(f));
      const decidedAt = new Date("2026-11-03T09:00:00Z");
      const approved = await repo.updateStatusIfCurrent({ companyId: f.companyId, id, from: "pending" }, { status: "approved", decidedAt, decisionNote: "Enjoy" });
      assert.equal(approved?.status, "approved");
      assert.deepEqual(approved?.decidedAt, decidedAt);
      assert.equal(approved?.decisionNote, "Enjoy");
      assert.equal(await repo.updateStatusIfCurrent({ companyId: f.companyId, id, from: "pending" }, { status: "rejected" }), undefined);
      assert.equal(await repo.updateStatusIfCurrent({ companyId: f.otherCompanyId, id, from: "approved" }, { status: "cancelled" }), undefined);
      assert.equal((await repo.find(f.companyId, id))?.status, "approved");
    });
  });

  test(`${name}: a status change guarded by the approver loses once the request is assigned elsewhere`, async () => {
    const { fixture: f, use } = await make();
    await use(async (repo) => {
      const { id } = await repo.insert(draft(f));
      const where = { companyId: f.companyId, id, from: "pending" as const };
      assert.equal(await repo.updateStatusIfCurrent({ ...where, approverId: f.otherUserId }, { status: "approved" }), undefined);
      assert.equal((await repo.updateStatusIfCurrent({ ...where, approverId: f.approverId }, { status: "approved" }))?.status, "approved");
    });
  });

  test(`${name}: a pending request moves to another approver only while it is still with the one read`, async () => {
    const { fixture: f, use } = await make();
    await use(async (repo) => {
      const { id } = await repo.insert(draft(f));
      const at = { companyId: f.companyId, id };
      assert.equal(await repo.reassignIfCurrent({ ...at, from: null }, f.otherUserId), undefined, "assigned to someone, not nobody");
      assert.equal(await repo.reassignIfCurrent({ companyId: f.otherCompanyId, id, from: f.approverId }, null), undefined);
      const moved = await repo.reassignIfCurrent({ ...at, from: f.approverId }, null);
      assert.equal(moved?.approverId, null);
      assert.equal((await repo.reassignIfCurrent({ ...at, from: null }, f.otherUserId))?.approverId, f.otherUserId);
      await repo.updateStatusIfCurrent({ ...at, from: "pending" }, { status: "approved" });
      assert.equal(await repo.reassignIfCurrent({ ...at, from: f.otherUserId }, f.approverId), undefined, "only while pending");
    });
  });

  test(`${name}: the per-year split is saved, read and replaced`, async () => {
    const { fixture: f, use } = await make();
    await use(async (repo) => {
      const a = await repo.insert(draft(f, { startDate: "2026-12-31", endDate: "2027-01-04", days: 3 }));
      const b = await repo.insert(draft(f, { startDate: "2026-11-02", endDate: "2026-11-02", days: 1 }));
      await repo.saveYearDays(a.id, [
        { year: 2026, days: 1 },
        { year: 2027, days: 2 },
      ]);
      await repo.saveYearDays(b.id, [{ year: 2026, days: 1 }]);
      const read = await repo.listYearDays([a.id, b.id, randomUUID()]);
      assert.deepEqual(
        [...read.keys()].sort(),
        [a.id, b.id].sort(),
      );
      assert.deepEqual(
        [...(read.get(a.id) ?? [])].sort((x, y) => x.year - y.year),
        [
          { year: 2026, days: 1 },
          { year: 2027, days: 2 },
        ],
      );
      await repo.replaceYearDays(a.id, [{ year: 2027, days: 1 }]);
      assert.deepEqual((await repo.listYearDays([a.id])).get(a.id), [{ year: 2027, days: 1 }]);
      const updated = await repo.updateDays(f.companyId, a.id, 1);
      assert.equal(updated.days, 1);
    });
  });

  test(`${name}: active requests on given dates, or from a date on, oldest start first`, async () => {
    const { fixture: f, use } = await make();
    await use(async (repo) => {
      const later = await repo.insert(draft(f, { startDate: "2026-11-25", endDate: "2026-11-27", status: "approved" }));
      const earlier = await repo.insert(draft(f, { startDate: "2026-11-09", endDate: "2026-11-10" }));
      await repo.insert(draft(f, { startDate: "2026-11-26", endDate: "2026-11-26", status: "rejected" }));
      await repo.insert(draft(f, { startDate: "2026-10-01", endDate: "2026-10-02" }));
      assert.deepEqual(
        (await repo.lockActiveOnDates(f.companyId, ["2026-11-26"])).map((r) => r.id),
        [later.id],
      );
      assert.deepEqual(
        (await repo.lockActiveOnDates(f.companyId, { from: "2026-11-01" })).map((r) => r.id),
        [earlier.id, later.id],
      );
      assert.deepEqual(await repo.lockActiveOnDates(f.otherCompanyId, { from: "2026-01-01" }), []);
    });
  });

  test(`${name}: counts a requester's requests of the last minutes, in any status`, async () => {
    const { fixture: f, use } = await make();
    await use(async (repo) => {
      await repo.insert(draft(f));
      await repo.insert(draft(f, { status: "cancelled", startDate: "2026-12-01", endDate: "2026-12-01" }));
      await repo.insert(draft(f, { userId: f.otherUserId }));
      assert.equal(await repo.countRecentByRequester(f.userId, 10), 2);
    });
  });

  test(`${name}: a person's own requests, latest dates first, with the leave type named; never someone else's`, async () => {
    const { fixture: f, use } = await make();
    await use(async (repo) => {
      const nov = await repo.insert(draft(f, { startDate: "2026-11-09", endDate: "2026-11-10" }));
      const dec = await repo.insert(draft(f, { startDate: "2026-12-07", endDate: "2026-12-07", days: 1, note: null }));
      const theirs = await repo.insert(draft(f, { userId: f.otherUserId }));
      const own = await repo.listOwn(f.companyId, f.userId, 10);
      assert.deepEqual(
        own.map((r) => r.id),
        [dec.id, nov.id],
      );
      assert.equal(at(own, 1).leaveTypeName, f.leaveTypeName);
      assert.equal(at(own, 1).note, "Family visit");
      assert.equal(at(own, 1).approverId, f.approverId);
      assert.equal((await repo.listOwn(f.companyId, f.userId, 1)).length, 1);
      assert.equal((await repo.findOwn(f.companyId, f.userId, nov.id))?.id, nov.id);
      assert.equal(await repo.findOwn(f.companyId, f.userId, theirs.id), undefined);
    });
  });

  test(`${name}: the API page is by start date then id, filtered, one past the limit, and carries no note`, async () => {
    const { fixture: f, use } = await make();
    await use(async (repo) => {
      const a = await repo.insert(draft(f, { startDate: "2026-11-02", endDate: "2026-11-02", days: 1 }));
      const b = await repo.insert(draft(f, { startDate: "2026-11-09", endDate: "2026-11-10", status: "approved" }));
      const c = await repo.insert(draft(f, { startDate: "2026-11-16", endDate: "2026-11-16", days: 1, userId: f.otherUserId }));
      const all = await repo.pageForApi({ companyId: f.companyId, limit: 2 });
      assert.deepEqual(
        all.map((r) => r.id),
        [a.id, b.id, c.id],
      );
      assert.ok(all.every((r) => !("note" in r) && !("decisionNote" in r) && !("companyId" in r)));
      assert.deepEqual(
        (await repo.pageForApi({ companyId: f.companyId, limit: 10, status: "approved" })).map((r) => r.id),
        [b.id],
      );
      assert.deepEqual(
        (await repo.pageForApi({ companyId: f.companyId, limit: 10, userId: f.otherUserId })).map((r) => r.id),
        [c.id],
      );
      assert.deepEqual(
        (await repo.pageForApi({ companyId: f.companyId, limit: 10, from: "2026-11-10", to: "2026-11-16" })).map((r) => r.id),
        [b.id, c.id],
      );
      assert.deepEqual(
        (await repo.pageForApi({ companyId: f.companyId, limit: 10, after: { startDate: b.startDate, id: b.id } })).map((r) => r.id),
        [c.id],
      );
    });
  });

  test(`${name}: decision times leave out approvers with too few decisions`, async () => {
    const { fixture: f, use } = await make();
    await use(async (repo) => {
      const { id } = await repo.insert(draft(f));
      await repo.updateStatusIfCurrent({ companyId: f.companyId, id, from: "pending" }, { status: "approved", decidedAt: new Date() });
      const since = new Date(Date.now() - 86_400_000);
      assert.deepEqual(await repo.medianDecisionHours({ companyId: f.companyId, approverIds: [f.approverId], since, minSamples: 2 }), []);
      assert.deepEqual(await repo.medianDecisionHours({ companyId: f.companyId, approverIds: [], since, minSamples: 1 }), []);
      const one = await repo.medianDecisionHours({ companyId: f.companyId, approverIds: [f.approverId], since, minSamples: 1 });
      assert.deepEqual(
        one.map((r) => r.approverId),
        [f.approverId],
      );
    });
  });
}
