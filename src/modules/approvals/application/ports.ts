import "server-only";
/**
 * The ports approvals' use cases depend on (Tier 3). Each is implemented against the
 * database in `infrastructure/` and in memory by the fakes in
 * `tests/unit/modules/approvals/fakes`; `composition.ts` wires the real ones.
 */
import type { CalendarDate } from "@/shared/kernel/calendar-date";
import type { PageRequest } from "@/shared/kernel/paging";
import type { AlsoOff, AlsoOffRequest, LeaveChange, LeaveRequest } from "@/modules/leave";
import type { Notification } from "@/modules/notifications";
import type { DayPortion, LeaveStatus } from "@/shared/kernel/leave-range";
import type { ApprovalContext, ApprovalRequester } from "../domain/approval-context";

/** A requester as routing reads them: who they are, and where to look for who decides. */
export interface RoutingRequester extends ApprovalRequester {
  departmentId: string | null;
}

/**
 * The one routing loader (AGENTS.md): what the approval rule needs, read inside the
 * deciding or re-routing transaction so it reflects who is active and who manages whom now.
 */
export interface ApprovalContextReader {
  /** Members of the company by id, active or not; anyone else is left out. */
  requesters(companyId: string, ids: readonly string[]): Promise<RoutingRequester[]>;
  /** Each requester's manager, department manager and the company's active admins, by requester id. */
  contextsFor(companyId: string, requesters: readonly RoutingRequester[]): Promise<Map<string, ApprovalContext>>;
}

/** One request with what an approver reads before deciding. */
export interface ReviewRequest {
  id: string;
  status: LeaveStatus;
  approverId: string | null;
  startDate: CalendarDate;
  endDate: CalendarDate;
  dayPortion: DayPortion;
  days: number;
  note: string | null;
  leaveTypeName: string;
  leaveTypeColor: string;
  requesterName: string;
  requesterEmail: string;
}

/** Leave requests, as approvals changes them: through leave, which owns the table. */
export interface ApprovalRequests {
  /** A request of the company, holding its row until the unit of work ends. */
  lock(companyId: string, id: string): Promise<LeaveRequest | undefined>;
  /** Compare-and-set on the status (and the assignment, with `approverId`); `undefined` when it lost. */
  decideIfCurrent(
    where: { companyId: string; id: string; from: LeaveStatus; approverId?: string | undefined },
    set: { status: LeaveStatus; decidedAt?: Date; decisionNote?: string | null },
  ): Promise<LeaveRequest | undefined>;
  /** Moves a pending request still assigned to `from` (`null`: nobody) to `approverId`; `undefined` when it lost. */
  reassignIfCurrent(where: { companyId: string; id: string; from: string | null }, approverId: string | null): Promise<LeaveRequest | undefined>;
  findForReview(companyId: string, id: string): Promise<ReviewRequest | undefined>;
}

export interface Contact {
  id: string;
  name: string;
  email: string;
}

/** The person an approve link names, as their account reads now (a deleted person reads as missing). */
export interface LinkPerson {
  id: string;
  companyId: string | null;
  role: string | null;
  canSelfApprove: boolean;
  isActive: boolean;
}

/** What approvals reads of people, leave types and the company. */
export interface ApprovalDirectory {
  /** Active people by id, so a deactivated person is never emailed. */
  activeContacts(companyId: string, ids: readonly (string | null)[]): Promise<Map<string, Contact>>;
  leaveTypeName(companyId: string, id: string): Promise<string | undefined>;
  /** Every leave type's name, archived ones too, by id. */
  leaveTypeNames(companyId: string): Promise<Map<string, string>>;
  linkPerson(userId: string): Promise<LinkPerson | undefined>;
  timezone(companyId: string): Promise<string | undefined>;
}

/** Writes a decision's or a reassignment's audit row and outbox event, through leave (ADR-0010). */
export interface ApprovalChangeLog {
  decision(change: LeaveChange): Promise<void>;
  reassignment(change: { before: LeaveRequest; after: LeaveRequest; source: LeaveChange["source"] }): Promise<void>;
}

/** Who is asking for the inbox, and whether they see every pending request in the company. */
export interface InboxScope {
  companyId: string;
  deciderId: string;
  isAdmin: boolean;
  /**
   * Narrows an admin's inbox: `mine` is what is assigned to them or to nobody, `others`
   * what is assigned to someone else. Omitted, the whole inbox. A non-admin's inbox is
   * all `mine`.
   */
  part?: "mine" | "others";
}

/** A pending request as the inbox lists it, with requester, leave type and approver named. */
export interface InboxRequest {
  id: string;
  /** `created_at` as the page key prints it. */
  cursor: string;
  startDate: CalendarDate;
  endDate: CalendarDate;
  dayPortion: DayPortion;
  days: number;
  note: string | null;
  createdAt: Date;
  leaveTypeName: string;
  leaveTypeColor: string;
  requesterId: string;
  requesterName: string;
  requesterEmail: string;
  requesterDepartmentId: string | null;
  requesterDepartmentName: string | null;
  approverId: string | null;
  approverName: string | null;
}

/** A decision as Settled lists it: the audited decision and the request as it is now. */
export interface RecentDecision {
  auditId: string;
  /** The audit row's `created_at` as the page key prints it. */
  cursor: string;
  id: string;
  action: string;
  decidedAt: Date;
  status: LeaveStatus;
  startDate: CalendarDate;
  endDate: CalendarDate;
  dayPortion: DayPortion;
  days: number;
  decisionNote: string | null;
  leaveTypeName: string;
  leaveTypeColor: string;
  requesterName: string;
  requesterEmail: string;
}

/** The Approvals page's reads. */
export interface ApprovalInbox {
  /** A page of the pending requests `scope` may act on, earliest start first, keyed on `[start_date, created_at, id]`. */
  list(scope: InboxScope, limit: number, page?: PageRequest): Promise<InboxRequest[]>;
  count(scope: InboxScope): Promise<number>;
  /** A page of what `deciderId` decided since `since` (never their own requests), newest first, keyed on the audit row. */
  recentDecisions(q: { companyId: string; deciderId: string; since: Date }, limit: number, page?: PageRequest): Promise<RecentDecision[]>;
  /** Who else is off during each request, as `readerId` may see it. */
  alsoOff(companyId: string, requests: readonly AlsoOffRequest[], readerId: string): Promise<Map<string, AlsoOff>>;
}

/** Every port, bound to one executor: the pool for reads, or one transaction. */
export interface ApprovalStore {
  requests: ApprovalRequests;
  contexts: ApprovalContextReader;
  directory: ApprovalDirectory;
  changes: ApprovalChangeLog;
  inbox: ApprovalInbox;
}

/** What signs an approve link: the key (absent where links cannot be signed), the app's URL and the clock. */
export interface LinkSigner {
  linkKey?: string | undefined;
  appUrl: string;
  now(): Date;
}

/** Everything an approvals use case runs against. */
export interface ApprovalDeps extends LinkSigner {
  /** Ports for reads outside a unit of work. */
  read: ApprovalStore;
  /** Runs `work` in one transaction with ports bound to it; its emails go out after commit. A thrown `DomainError` rolls it back. */
  unitOfWork<T>(companyId: string, work: (store: ApprovalStore) => Promise<{ result: T; notify: Notification[] }>): Promise<T>;
}
