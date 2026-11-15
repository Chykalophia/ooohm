import "server-only";
import type { PersonChangeSource } from "@/shared/kernel/change-source";
import {
  LEAVE_EVENT_TYPES,
  LEAVE_REASSIGNED_EVENT_TYPE,
  LEAVE_RECOUNTED_EVENT_TYPE,
  type LeaveReassignedPayload,
  type LeaveRecountedPayload,
  leaveAuditAction,
  leaveEventPayload,
} from "@/shared/kernel/events";
import { personLabel } from "@/shared/kernel/person-label";
import type { LeaveSummary } from "@/modules/notifications";
import type { LeaveDomainEvent } from "../domain/events";
import { LEAVE_EVENT_NAMES } from "../domain/events";
import type { LeaveRequest } from "../domain/leave-request";
import type { ChangeLog, Contact, LeaveDirectory } from "./ports";

/** The audited view of a request: every field a transition can change or depends on. */
export function snapshot(row: LeaveRequest) {
  return {
    status: row.status,
    leaveTypeId: row.leaveTypeId,
    startDate: row.startDate,
    endDate: row.endDate,
    dayPortion: row.dayPortion,
    days: row.days,
    note: row.note,
    approverId: row.approverId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
  };
}

/** The audit row of one transition of `after` (`leave_request.<action>`). */
function auditOf(action: string, before: LeaveRequest | null, after: LeaveRequest) {
  return {
    companyId: after.companyId,
    action,
    entityType: "leave_request",
    entityId: after.id,
    subjectUserId: after.userId,
    before: before ? snapshot(before) : null,
    after: snapshot(after),
  };
}

/** One leave transition: what it was, the request before (`null` when just created) and after, and who made it. */
export interface LeaveChange {
  event: keyof typeof LEAVE_EVENT_TYPES;
  before: LeaveRequest | null;
  after: LeaveRequest;
  /** The person who made it: the requester, the approver or an admin. */
  source: PersonChangeSource;
}

/** Writes the audit row and outbox event for one leave transition. */
export async function recordLeaveChangeIn(changes: ChangeLog, change: LeaveChange): Promise<void> {
  const { after, source } = change;
  await changes.record({
    source,
    audit: auditOf(leaveAuditAction(change.event), change.before, after),
    event: { companyId: after.companyId, type: LEAVE_EVENT_TYPES[change.event], payload: leaveEventPayload(after, source) },
  });
}

/** {@link recordLeaveChangeIn} for a domain event, with the request as stored (`before` and `after`). */
export function recordEvent(changes: ChangeLog, event: LeaveDomainEvent, stored: { before: LeaveRequest | null; after: LeaveRequest }, source: PersonChangeSource) {
  return recordLeaveChangeIn(changes, { event: LEAVE_EVENT_NAMES[event.type], ...stored, source });
}

/** Writes `leave_request.reassigned` and `leave.reassigned` for a pending request moved to another approver. */
export async function recordReassignmentIn(
  changes: ChangeLog,
  change: { before: LeaveRequest; after: LeaveRequest; source: PersonChangeSource },
): Promise<void> {
  const { before, after, source } = change;
  const payload: LeaveReassignedPayload = {
    ...leaveEventPayload(after, source),
    previousApproverId: before.approverId,
    approverId: after.approverId,
  };
  await changes.record({
    source,
    audit: auditOf(leaveAuditAction("reassigned"), before, after),
    event: { companyId: after.companyId, type: LEAVE_REASSIGNED_EVENT_TYPE, payload },
  });
}

/** Writes `leave_request.recounted` and `leave.recounted` for a request whose day count changed with the calendar. */
export async function recordRecountIn(
  changes: ChangeLog,
  change: { before: LeaveRequest; after: LeaveRequest; source: PersonChangeSource },
): Promise<void> {
  const { before, after, source } = change;
  const payload: LeaveRecountedPayload = { ...leaveEventPayload(after, source), previousDays: before.days };
  await changes.record({
    source,
    audit: auditOf(leaveAuditAction("recounted"), before, after),
    event: { companyId: after.companyId, type: LEAVE_RECOUNTED_EVENT_TYPE, payload },
  });
}

/** Active recipients by id, so a deactivated person is never emailed. */
export async function activeContactsIn(directory: LeaveDirectory, companyId: string, ids: readonly (string | null)[]): Promise<Map<string, Contact>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const rows = await directory.contacts(companyId, wanted);
  return new Map(rows.filter((r) => r.isActive).map((r) => [r.id, r]));
}

/**
 * The request as an email shows it.
 *
 * @param requester The requester's contact, if active; names them in other people's mail.
 */
export function summarize(
  row: Pick<LeaveRequest, "startDate" | "endDate" | "dayPortion" | "days" | "note">,
  requester: { name: string; email: string } | undefined,
  leaveTypeName: string,
): LeaveSummary {
  return {
    requesterName: requester ? personLabel(requester) : "",
    leaveTypeName,
    startDate: row.startDate,
    endDate: row.endDate,
    dayPortion: row.dayPortion,
    days: row.days,
    note: row.note,
  };
}
