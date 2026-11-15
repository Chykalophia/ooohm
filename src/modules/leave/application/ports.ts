import "server-only";
/**
 * The ports leave's use cases depend on (Tier 3). Each is implemented against the
 * database in `infrastructure/` and in memory by the fakes in `tests/unit/modules/leave/fakes`;
 * `composition.ts` wires the real ones. Leave owns these interfaces; its infrastructure
 * adapts them onto the balances module and the approval routing, which never import leave.
 */
import type { Role } from "@/domain/actor";
import type { ApprovalContext } from "@/domain/approval-rule";
import type { CalendarDate } from "@/domain/calendar-date";
import type { ChangeSource } from "@/domain/change-source";
import type { PageRequest } from "@/domain/paging";
import type { Notification } from "@/modules/notifications";
import type { AuditEntry, OutboxEvent } from "@/shared/lib/db/change-log";
import type { LeaveTypeSettingsDTO as LeaveTypeRow } from "@/modules/organisation";
import type { PersonRow } from "@/server/repositories/users";
import type { AllowancePolicy, BalanceInputs, BalanceSummary, LeaveAssessment, LeaveDraft, LeaveTypeWithAllowance } from "@/modules/balances";
import type { IdGenerator } from "@/shared/lib/id-generator";
import type { YearDays } from "@/shared/kernel/leave-days";
import type { DayPortion, LeaveRange, LeaveStatus } from "@/shared/kernel/leave-range";
import type { DateRange } from "../domain/date-range";
import type { LeaveRequest } from "../domain/leave-request";
import type { AlsoOff, AlsoOffRequest } from "./queries/also-off";

/** One of a person's own requests as "Your requests" lists it, with the leave type and approver named. */
export interface OwnRequest {
  id: string;
  /** `created_at` as the page key prints it. */
  cursor: string;
  startDate: CalendarDate;
  endDate: CalendarDate;
  dayPortion: DayPortion;
  days: number;
  status: LeaveStatus;
  note: string | null;
  decisionNote: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  leaveTypeName: string;
  leaveTypeColor: string;
  approverId: string | null;
  approverName: string | null;
}

/** A leave request as the REST API lists it: never a note. */
export type ApiLeaveRequest = Omit<LeaveRequest, "note" | "decisionNote" | "companyId">;

/** Which page of the API's leave requests to read. */
export interface ApiLeaveRequestPage {
  companyId: string;
  from?: CalendarDate;
  to?: CalendarDate;
  userId?: string;
  status?: LeaveStatus;
  after?: { startDate: CalendarDate; id: string };
  limit: number;
}

/** The leave request table and its per-year split, with intention-revealing methods. */
export interface LeaveRequestRepository {
  find(companyId: string, id: string): Promise<LeaveRequest | undefined>;
  /** {@link find}, holding the row until the unit of work ends. */
  lock(companyId: string, id: string): Promise<LeaveRequest | undefined>;
  /** Requests, in any status, `userId` created in the last `minutes` (the database clock). */
  countRecentByRequester(userId: string, minutes: number): Promise<number>;
  /** The requester's pending and approved requests that share a date with `range`. */
  findActiveOverlapping(userId: string, range: DateRange): Promise<LeaveRange[]>;
  /** Stores a new request as given (its timestamps come from the store) and returns it as stored. */
  insert(request: LeaveRequest): Promise<LeaveRequest>;
  /** Stores what a new request costs per calendar year. */
  saveYearDays(requestId: string, split: readonly YearDays[]): Promise<void>;
  /** Compare-and-set on the status: `undefined` when it is no longer `from`. */
  updateStatusIfCurrent(
    where: { companyId: string; id: string; from: LeaveStatus },
    set: { status: LeaveStatus; decidedAt?: Date; decisionNote?: string | null },
  ): Promise<LeaveRequest | undefined>;
  /** Locks the company's pending and approved requests on any of `dates`, or ending on or after `from`; oldest start first. */
  lockActiveOnDates(companyId: string, dates: readonly string[] | { from: string }): Promise<LeaveRequest[]>;
  listYearDays(requestIds: readonly string[]): Promise<Map<string, YearDays[]>>;
  replaceYearDays(requestId: string, split: readonly YearDays[]): Promise<void>;
  /** Sets a locked request's total days. */
  updateDays(companyId: string, id: string, days: number): Promise<LeaveRequest>;
  /** A page of a person's own requests, latest dates first. */
  listOwn(companyId: string, userId: string, limit: number, page?: PageRequest): Promise<OwnRequest[]>;
  findOwn(companyId: string, userId: string, id: string): Promise<OwnRequest | undefined>;
  /** Each approver's median hours from request to decision since `since`, for approvers with `minSamples` decisions. */
  medianDecisionHours(q: { companyId: string; approverIds: readonly string[]; since: Date; minSamples: number }): Promise<{ approverId: string; hours: number }[]>;
  /** A page of the company's requests for the REST API, by start date then id (one more than `limit`). */
  pageForApi(q: ApiLeaveRequestPage): Promise<ApiLeaveRequest[]>;
}

/** A requester as the approval rule needs them. */
export interface Requester {
  id: string;
  role: Role;
  canSelfApprove: boolean;
  managerId: string | null;
  departmentId: string | null;
  isActive: boolean;
  createdAt: Date;
}

export type Person = PersonRow;
export interface Contact {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
}
export interface Department {
  id: string;
  name: string;
  managerId: string | null;
  maxOff: number | null;
}
export interface CompanySettings {
  timezone: string;
  workingDays: number[];
  allowancePolicy: string;
  approvalMode: string;
  departmentScoping: boolean;
}
export interface CompanyFacts {
  timezone: string;
  allowancePolicy: string;
  managersSeeDetails: boolean;
}

/** What leave reads of the company, its people, departments and leave types. */
export interface LeaveDirectory {
  /** Shares the company row lock with other submits, exclusive with a calendar change. */
  shareLockCompany(companyId: string): Promise<void>;
  companySettings(companyId: string): Promise<CompanySettings | undefined>;
  company(companyId: string): Promise<CompanyFacts | undefined>;
  holidayDates(companyId: string, from: string, to: string): Promise<string[]>;
  /** A member, holding their row lock: serialises one person's submits. */
  lockMember(companyId: string, userId: string): Promise<Requester | undefined>;
  lockPerson(companyId: string, userId: string): Promise<Person | undefined>;
  findPerson(companyId: string, userId: string): Promise<Person | undefined>;
  department(companyId: string, id: string): Promise<Department | undefined>;
  /** People by id, active or not. */
  contacts(companyId: string, ids: readonly string[]): Promise<Contact[]>;
  leaveType(companyId: string, id: string): Promise<{ id: string; name: string } | undefined>;
  leaveTypeForAdmin(companyId: string, id: string): Promise<LeaveTypeRow | undefined>;
  leaveTypesWithAllowance(companyId: string): Promise<LeaveTypeWithAllowance[]>;
}

/** Balances' public API, as leave needs it. */
export interface AllowanceReader {
  /** Counts and checks a draft for `person` (the computation the preview runs); throws `DomainError`. */
  assess(person: { id: string; companyId: string }, draft: LeaveDraft): Promise<LeaveAssessment>;
  summarize(person: { id: string; companyId: string }, loaded: { allowancePolicy: string; types: readonly LeaveTypeWithAllowance[]; year: number }): Promise<BalanceSummary>;
  /** The balance inputs (allowances, booked days and defaults) for these people, types and years. */
  balancesFor(companyId: string, scope: { userIds: string[]; leaveTypeIds: string[]; years: number[] }): Promise<BalanceInputs>;
  /** Re-carries a closed year's unused days into the next, as the rollover would (the one write). */
  recarry(job: { companyId: string; timezone: string; policy: AllowancePolicy; member: Person; leaveType: LeaveTypeRow; closingYear: number; source: ChangeSource }): Promise<void>;
}

/** Approvals' public API, as leave needs it. */
export interface ApprovalRouter {
  /** What the approval rule needs to route `requester`'s request now. */
  contextFor(companyId: string, requester: Requester): Promise<ApprovalContext>;
  /** Who the approval rule (minus self-approval) picks for `requesterId` now. */
  currentApprover(companyId: string, requesterId: string): Promise<string | null>;
}

/** Writes one change's audit row and outbox event together (ADR-0010). */
export interface ChangeLog {
  record(change: { source: ChangeSource; audit: AuditEntry; event: OutboxEvent }): Promise<void>;
}

/** Who else is off during requests, as their approver reads it. */
export interface AlsoOffReader {
  lines(companyId: string, requests: readonly AlsoOffRequest[], readerId?: string): Promise<Map<string, AlsoOff>>;
}

/** Every port, bound to one executor: the pool for reads, or one transaction. */
export interface LeaveStore {
  requests: LeaveRequestRepository;
  directory: LeaveDirectory;
  allowances: AllowanceReader;
  approvals: ApprovalRouter;
  changes: ChangeLog;
  alsoOff: AlsoOffReader;
}

export interface Clock {
  now(): Date;
}

/** Everything a leave use case runs against. */
export interface LeaveDeps {
  clock: Clock;
  ids: IdGenerator;
  /** Public base URL for links in emails, without a trailing slash. */
  appUrl: string;
  /** The signed Approve link for a request email, or `null` where links cannot be signed. */
  approveLink(requestId: string, approverId: string): string | null;
  /** Ports for reads outside a unit of work. */
  read: LeaveStore;
  /**
   * Runs `work` in one transaction with ports bound to it; its emails go out after
   * commit. A thrown `DomainError` rolls everything back.
   */
  unitOfWork<T>(companyId: string, work: (store: LeaveStore) => Promise<{ result: T; notify: Notification[] }>): Promise<T>;
}
