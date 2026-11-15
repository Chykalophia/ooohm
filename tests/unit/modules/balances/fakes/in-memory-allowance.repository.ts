import { randomUUID } from "node:crypto";
import type { AllowanceRepository } from "@/modules/balances/application/ports";
import type { Allowance, BalanceScope, BookedDaysOf, NewAllowance } from "@/modules/balances/domain/allowance";
import { addDays } from "@/shared/kernel/day-amounts";
import type { LeaveStatus } from "@/shared/kernel/leave-range";

/** What one request costs in one year, as `leave_request_days` joined to its request stores it. */
export interface BookedEntry {
  userId: string;
  leaveTypeId: string;
  year: number;
  days: number;
  status: LeaveStatus;
}

const key = (a: { userId: string; leaveTypeId: string; year: number }) => `${a.userId}|${a.leaveTypeId}|${a.year}`;

/** The `allowances` table and the booked days of `leave_request_days`, in memory. */
export class InMemoryAllowanceRepository implements AllowanceRepository {
  /** Rows by id. */
  readonly rows = new Map<string, Allowance>();
  readonly booked: BookedEntry[] = [];
  /** Ids of rows locked by {@link lockFrom}, in order. */
  readonly locked: string[] = [];

  constructor(private readonly newId: () => string = randomUUID) {}

  /** Stores a row as given (a test's setup). */
  seed(row: NewAllowance): Allowance {
    const stored = { id: this.newId(), carriedOverDays: 0, adjustmentDays: 0, ...row };
    this.rows.set(stored.id, stored);
    return { ...stored };
  }

  byKey(where: { userId: string; leaveTypeId: string; year: number }): Allowance | undefined {
    const hit = [...this.rows.values()].find((r) => key(r) === key(where));
    return hit && { ...hit };
  }

  private static empty(scope: BalanceScope): boolean {
    return scope.userIds.length === 0 || scope.years.length === 0 || scope.leaveTypeIds?.length === 0;
  }

  private static covers(scope: { userIds: readonly string[]; leaveTypeIds?: readonly string[] }, r: { userId: string; leaveTypeId: string }): boolean {
    return scope.userIds.includes(r.userId) && (!scope.leaveTypeIds || scope.leaveTypeIds.includes(r.leaveTypeId));
  }

  async list(scope: BalanceScope): Promise<Allowance[]> {
    if (InMemoryAllowanceRepository.empty(scope)) return [];
    const firstYear = Math.min(...scope.years);
    const inScope = [...this.rows.values()].filter((r) => InMemoryAllowanceRepository.covers(scope, r));
    const latestEarlier = (r: Allowance) =>
      Math.max(...inScope.filter((o) => o.userId === r.userId && o.leaveTypeId === r.leaveTypeId && o.year < firstYear).map((o) => o.year));
    return inScope.filter((r) => scope.years.includes(r.year) || r.year === latestEarlier(r)).map((r) => ({ ...r }));
  }

  async sumBooked(scope: BalanceScope): Promise<BookedDaysOf[]> {
    if (InMemoryAllowanceRepository.empty(scope)) return [];
    const sums = new Map<string, BookedDaysOf>();
    for (const e of this.booked) {
      if (!InMemoryAllowanceRepository.covers(scope, e) || !scope.years.includes(e.year)) continue;
      if (e.status !== "approved" && e.status !== "pending") continue;
      const sum = sums.get(key(e)) ?? { userId: e.userId, leaveTypeId: e.leaveTypeId, year: e.year, approved: 0, pending: 0 };
      sum[e.status] = addDays(sum[e.status], e.days);
      sums.set(key(e), sum);
    }
    return [...sums.values()];
  }

  async find(where: { userId: string; leaveTypeId: string; year: number }): Promise<Allowance | undefined> {
    return this.byKey(where);
  }

  async insertMissing(rows: readonly NewAllowance[]): Promise<Allowance[]> {
    return rows.flatMap((row) => (this.byKey(row) ? [] : [this.seed(row)]));
  }

  private update(id: string, set: Partial<Allowance>): Allowance {
    const row = this.rows.get(id);
    if (!row) throw new Error(`No allowance ${id}`);
    const after = { ...row, ...set };
    this.rows.set(id, after);
    return { ...after };
  }

  async setCarriedOverDays(id: string, carriedOverDays: number): Promise<Allowance> {
    return this.update(id, { carriedOverDays });
  }

  async setDays(id: string, days: number): Promise<Allowance> {
    return this.update(id, { days });
  }

  async writeOverride(values: { userId: string; leaveTypeId: string; year: number; days: number; adjustmentDays: number }): Promise<Allowance> {
    const existing = this.byKey(values);
    if (existing) return this.update(existing.id, { days: values.days, adjustmentDays: values.adjustmentDays });
    return this.seed(values);
  }

  async lockFrom(scope: { userIds: readonly string[]; fromYear: number; leaveTypeIds?: readonly string[] }): Promise<Allowance[]> {
    if (scope.userIds.length === 0 || scope.leaveTypeIds?.length === 0) return [];
    const rows = [...this.rows.values()]
      .filter((r) => InMemoryAllowanceRepository.covers(scope, r) && r.year >= scope.fromYear)
      .sort((a, b) => a.userId.localeCompare(b.userId) || a.leaveTypeId.localeCompare(b.leaveTypeId) || a.year - b.year);
    this.locked.push(...rows.map((r) => r.id));
    return rows.map((r) => ({ ...r }));
  }
}
