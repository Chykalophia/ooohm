import type { CalendarDate } from "@/shared/kernel/calendar-date";
import { type DayPortion, type LeaveRange, type LeaveStatus, rangesOverlap } from "@/shared/kernel/leave-range";
import { err, fromDomainError, ok, type ServiceResult } from "@/shared/lib/result";
import type { DateRange } from "./date-range";
import type { DayCount } from "./day-count";
import { assertCancellableOn, assertRemovableOn, assertTransition } from "./leave-status";

/**
 * The leave request aggregate: someone's time off, from asking to a decision. Its rules
 * live here as pure functions over this readonly value (ADR-0003): each returns the new
 * state and what happened, or a failure, and changes nothing in place.
 */
export interface LeaveRequest {
  readonly id: string;
  readonly companyId: string;
  /** The requester: whose time off it is. */
  readonly userId: string;
  readonly leaveTypeId: string;
  readonly startDate: CalendarDate;
  readonly endDate: CalendarDate;
  readonly dayPortion: DayPortion;
  /** Working days it costs (one decimal place). */
  readonly days: number;
  readonly note: string | null;
  readonly status: LeaveStatus;
  readonly approverId: string | null;
  readonly decidedAt: Date | null;
  readonly decisionNote: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * What happened to a leave request, as the aggregate reports it. The use case records
 * each one (`audit_log` + `events_outbox`, in the same transaction) under its public
 * name (`LEAVE_EVENT_NAMES` in `events.ts`).
 */
export type LeaveDomainEvent =
  | { readonly type: "LeaveRequested"; readonly request: LeaveRequest }
  | { readonly type: "LeaveApproved"; readonly before: LeaveRequest; readonly request: LeaveRequest }
  | { readonly type: "LeaveCancelled"; readonly before: LeaveRequest; readonly request: LeaveRequest };

/** What a new request is made of, once its dates, days and approver are known. */
export interface LeaveDraftFacts {
  readonly id: string;
  readonly companyId: string;
  readonly userId: string;
  readonly leaveTypeId: string;
  readonly range: DateRange;
  readonly days: DayCount;
  readonly note: string | null;
  readonly approverId: string | null;
}

/** A submitted request: as first stored (`pending`), and approved too when the approval rule approves it at once. */
export interface Submission {
  readonly requested: LeaveRequest;
  readonly approved: LeaveRequest | null;
  readonly events: readonly LeaveDomainEvent[];
}

/** A request after one transition, and the event it records. */
export interface Transition {
  readonly request: LeaveRequest;
  readonly event: LeaveDomainEvent;
}

/**
 * Submits a request: `pending`, then `approved` at once when `autoApprove` (self-approval,
 * a request added for someone, or approval turned off). Records `LeaveRequested`, then
 * `LeaveApproved`. Fails with `overlapping_request` when it claims time one of the
 * requester's `active` (pending or approved) requests already holds.
 */
export function submitLeave(input: {
  draft: LeaveDraftFacts;
  active: readonly LeaveRange[];
  autoApprove: boolean;
  now: Date;
}): ServiceResult<Submission> {
  const { draft, now } = input;
  if (input.active.some((other) => rangesOverlap(draft.range, other))) return err("overlapping_request");
  const requested: LeaveRequest = {
    id: draft.id,
    companyId: draft.companyId,
    userId: draft.userId,
    leaveTypeId: draft.leaveTypeId,
    ...draft.range,
    days: draft.days,
    note: draft.note,
    status: "pending",
    approverId: draft.approverId,
    decidedAt: null,
    decisionNote: null,
    createdAt: now,
    updatedAt: now,
  };
  const events: LeaveDomainEvent[] = [{ type: "LeaveRequested", request: requested }];
  if (!input.autoApprove) return ok({ requested, approved: null, events });
  const approval = approveLeave(requested, now);
  if (!approval.ok) return approval;
  return ok({ requested, approved: approval.value.request, events: [...events, approval.value.event] });
}

/** Approves a pending request at `now`. Fails with `invalid_transition` from any other status. */
export function approveLeave(request: LeaveRequest, now: Date): ServiceResult<Transition> {
  const checked = check(() => assertTransition(request.status, "approved"));
  if (!checked.ok) return checked;
  const after: LeaveRequest = { ...request, status: "approved", decidedAt: now, updatedAt: now };
  return ok({ request: after, event: { type: "LeaveApproved", before: request, request: after } });
}

/**
 * The requester cancels their request, pending or approved, on `today` (company time
 * zone). Fails with `invalid_transition` (already rejected or cancelled),
 * `past_year_closed` (approved leave of a closed year) or `leave_taken` (approved leave
 * that is over).
 */
export function cancelLeave(request: LeaveRequest, today: CalendarDate): ServiceResult<Transition> {
  const checked = check(() => assertCancellableOn(request, today));
  if (!checked.ok) return checked;
  return cancelled(request, request.decisionNote);
}

/**
 * A manager or admin removes approved leave to correct the record, saying why. Fails
 * with `invalid_transition` (not approved) or `past_year_closed`.
 */
export function removeLeave(request: LeaveRequest, today: CalendarDate, reason: string): ServiceResult<Transition> {
  const checked = check(() => assertRemovableOn(request, today));
  if (!checked.ok) return checked;
  return cancelled(request, reason);
}

function cancelled(request: LeaveRequest, decisionNote: string | null): ServiceResult<Transition> {
  const after: LeaveRequest = { ...request, status: "cancelled", decisionNote };
  return ok({ request: after, event: { type: "LeaveCancelled", before: request, request: after } });
}

/** A status-machine assertion as a result. */
function check(assertion: () => void): ServiceResult<void> {
  try {
    assertion();
    return ok(undefined);
  } catch (error) {
    return fromDomainError(error);
  }
}
