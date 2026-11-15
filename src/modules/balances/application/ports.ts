import "server-only";
/**
 * The ports balances' use cases depend on (Tier 3). Each is implemented against the
 * database in `infrastructure/` and in memory by the fakes in
 * `tests/unit/modules/balances/fakes`; `composition.ts` wires the real ones.
 */
import type { Actor } from "@/domain/actor";
import type { CalendarDate } from "@/domain/calendar-date";
import type { ChangeSource } from "@/domain/change-source";
import type { recordAdminChange } from "@/shared/lib/admin-access";
import type { AuditEntry, OutboxEvent } from "@/shared/lib/db/change-log";
import type { DayPortion } from "@/shared/kernel/leave-range";
import type { LeaveTypeAllowanceSettings } from "../domain/allowance-policy";
import type { Allowance, BalanceScope, BookedDaysOf, NewAllowance } from "../domain/allowance";
import type { AllowanceRule, Placement } from "../domain/allowance-rules";

/** The `allowances` table and the booked-day sums of `leave_request_days`. */
export interface AllowanceRepository {
  /**
   * Allowance rows in scope, plus, for each person and leave type, their latest row
   * before the earliest year in scope (the row a type without a default inherits from).
   */
  list(scope: BalanceScope): Promise<Allowance[]>;
  /** Approved and pending days per person, leave type and year; combinations with nothing booked are absent. */
  sumBooked(scope: BalanceScope): Promise<BookedDaysOf[]>;
  find(where: { userId: string; leaveTypeId: string; year: number }): Promise<Allowance | undefined>;
  /** Inserts the rows that do not exist yet (same person, type and year); returns only those it created. */
  insertMissing(rows: readonly NewAllowance[]): Promise<Allowance[]>;
  setCarriedOverDays(id: string, carriedOverDays: number): Promise<Allowance>;
  setDays(id: string, days: number): Promise<Allowance>;
  /**
   * Writes an admin's override: `days` and `adjustmentDays` only. A new row starts with
   * nothing carried over; an existing row keeps its `carried_over_days`.
   */
  writeOverride(values: { userId: string; leaveTypeId: string; year: number; days: number; adjustmentDays: number }): Promise<Allowance>;
  /** The rows of `userIds` for `fromYear` and later, optionally of some leave types only, locked until the unit of work ends; ordered by person, type and year. */
  lockFrom(scope: { userIds: readonly string[]; fromYear: number; leaveTypeIds?: readonly string[] }): Promise<Allowance[]>;
}

/** A stored allowance rule. */
export interface StoredAllowanceRule extends AllowanceRule {
  id: string;
}

/** The `allowance_rules` table, and where people sit as far as rules go. */
export interface AllowanceRuleRepository {
  /** The company's rules, optionally of one leave type, oldest first. */
  list(companyId: string, leaveTypeId?: string): Promise<StoredAllowanceRule[]>;
  find(companyId: string, id: string): Promise<StoredAllowanceRule | undefined>;
  /** The rule for exactly this type and target, if there is one. */
  findFor(companyId: string, leaveTypeId: string, target: Placement): Promise<StoredAllowanceRule | undefined>;
  insert(values: { companyId: string; leaveTypeId: string; departmentId: string | null; levelId: string | null; days: number }): Promise<StoredAllowanceRule>;
  updateDays(companyId: string, id: string, days: number): Promise<StoredAllowanceRule>;
  delete(companyId: string, id: string): Promise<void>;
  /** Where each of `userIds` sits: department and level. */
  placements(companyId: string, userIds: readonly string[]): Promise<Map<string, Placement>>;
  /** Undeleted members (active or not) in the department and/or at the level, by id. */
  membersAt(companyId: string, target: Placement): Promise<string[]>;
}

/** A company as balances read it. */
export interface BalancesCompany {
  id: string;
  timezone: string;
  workingDays: number[];
  allowancePolicy: string;
}

/** A leave type with its allowance settings. */
export interface AllowanceLeaveType extends LeaveTypeAllowanceSettings {
  id: string;
  name: string;
  code: string;
  color: string;
}

/** {@link AllowanceLeaveType}, archived ones flagged. */
export interface LeaveTypeWithAllowance extends AllowanceLeaveType {
  archived: boolean;
}

/** A leave type as the admin screens hold it. */
export interface AdminLeaveType extends AllowanceLeaveType {
  archivedAt: Date | null;
}

/** A member as the balance writers lock them. */
export interface BalancesMember {
  id: string;
  isActive: boolean;
  createdAt: Date;
}

/** What balances read of companies, calendars, people, leave types, departments and levels. */
export interface BalancesDirectory {
  /** Every company, for the year rollover. */
  companies(): Promise<BalancesCompany[]>;
  company(companyId: string): Promise<BalancesCompany | undefined>;
  /** The company, holding its row lock until the unit of work ends. */
  lockCompany(companyId: string): Promise<BalancesCompany | undefined>;
  /** @throws DomainError `forbidden` unless `actor` is still an active admin. */
  assertActiveAdmin(actor: Actor): Promise<void>;
  holidayDates(companyId: string, from: string, to: string): Promise<CalendarDate[]>;
  holidays(companyId: string, from: string, to: string): Promise<{ date: CalendarDate; name: string }[]>;
  /** The person's pending and approved requests that share a date with `from`…`to`. */
  activeRequestsInRange(userId: string, from: string, to: string): Promise<{ startDate: CalendarDate; endDate: CalendarDate; dayPortion: DayPortion }[]>;
  /** A non-archived leave type of the company. */
  activeLeaveType(companyId: string, id: string): Promise<AllowanceLeaveType | undefined>;
  /** Non-archived leave types in display order. */
  activeLeaveTypes(companyId: string): Promise<AllowanceLeaveType[]>;
  /** Every leave type, archived ones flagged, for balance views. */
  leaveTypesWithAllowance(companyId: string): Promise<LeaveTypeWithAllowance[]>;
  /** Any leave type of the company, archived or not. */
  leaveTypeForAdmin(companyId: string, id: string): Promise<AdminLeaveType | undefined>;
  allLeaveTypes(companyId: string): Promise<AdminLeaveType[]>;
  activeMembers(companyId: string): Promise<{ id: string; createdAt: Date }[]>;
  /** A member (never a deleted one), holding their row lock: the lock submit and every balance writer take. */
  lockMember(companyId: string, userId: string): Promise<BalancesMember | undefined>;
  lockMembers(companyId: string, userIds: readonly string[]): Promise<void>;
  departments(companyId: string): Promise<{ id: string; name: string }[]>;
  department(companyId: string, id: string): Promise<{ id: string; name: string } | undefined>;
  levels(companyId: string): Promise<{ id: string; name: string }[]>;
  level(companyId: string, id: string): Promise<{ id: string; name: string } | undefined>;
}

/** One admin change, as `recordAdminChange` takes it. */
export type AdminChange = Parameters<typeof recordAdminChange>[2];

/** Writes one change's audit row and outbox event together (ADR-0010). */
export interface ChangeLog {
  record(change: { source: ChangeSource; audit: AuditEntry; event: OutboxEvent }): Promise<void>;
  /** An admin's change, as `recordAdminChange` records it. */
  recordAdmin(actor: Actor, change: AdminChange): Promise<void>;
}

/** Every port, bound to one executor: the pool for reads, or one transaction. */
export interface BalancesStore {
  allowances: AllowanceRepository;
  rules: AllowanceRuleRepository;
  directory: BalancesDirectory;
  changes: ChangeLog;
}

export interface Clock {
  now(): Date;
}

/** Everything a balances use case runs against. */
export interface BalancesDeps {
  clock: Clock;
  /** Ports for reads outside a unit of work. */
  read: BalancesStore;
  /** Runs `work` in one transaction with ports bound to it. A thrown `DomainError` rolls everything back. */
  unitOfWork<T>(work: (store: BalancesStore) => Promise<T>): Promise<T>;
}
