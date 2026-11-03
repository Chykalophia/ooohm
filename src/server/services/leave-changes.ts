import type { Transaction } from "@/db/types";
import type { PersonChangeSource } from "@/domain/change-source";
import {
  LEAVE_EVENT_TYPES,
  LEAVE_REASSIGNED_EVENT_TYPE,
  LEAVE_RECOUNTED_EVENT_TYPE,
  type LeaveReassignedPayload,
  type LeaveRecountedPayload,
  leaveAuditAction,
  leaveEventPayload,
} from "@/domain/events";
import { personLabel } from "@/domain/person";
import type { LeaveSummary } from "@/server/email/leave-emails";
import { recordChange } from "@/server/repositories/change-log";
import type { LeaveRequestRow } from "@/server/repositories/leave-requests";
import { findContacts } from "@/server/repositories/users";

/** The audited view of a request: every field a transition can change or depends on. */
export function snapshot(row: LeaveRequestRow) {
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

/**
 * Writes the audit row and outbox event for one leave transition, inside `tx`.
 *
 * @param before The request before the change, or `null` when it was just created.
 * @param source The person who made it: the requester, the approver or an admin.
 */
export async function recordLeaveChange(
  tx: Transaction,
  change: {
    event: keyof typeof LEAVE_EVENT_TYPES;
    before: LeaveRequestRow | null;
    after: LeaveRequestRow;
    source: PersonChangeSource;
  },
): Promise<void> {
  const { after, source } = change;
  await recordChange(tx, {
    source,
    audit: {
      companyId: after.companyId,
      action: leaveAuditAction(change.event),
      entityType: "leave_request",
      entityId: after.id,
      subjectUserId: after.userId,
      before: change.before ? snapshot(change.before) : null,
      after: snapshot(after),
    },
    event: {
      companyId: after.companyId,
      type: LEAVE_EVENT_TYPES[change.event],
      payload: leaveEventPayload(after, source),
    },
  });
}

/**
 * Writes the audit row (`leave_request.reassigned`) and the `leave.reassigned` event
 * for a pending request moved to another approver, inside `tx`.
 */
export async function recordReassignment(
  tx: Transaction,
  change: { before: LeaveRequestRow; after: LeaveRequestRow; source: PersonChangeSource },
): Promise<void> {
  const { before, after, source } = change;
  const payload: LeaveReassignedPayload = {
    ...leaveEventPayload(after, source),
    previousApproverId: before.approverId,
    approverId: after.approverId,
  };
  await recordChange(tx, {
    source,
    audit: {
      companyId: after.companyId,
      action: leaveAuditAction("reassigned"),
      entityType: "leave_request",
      entityId: after.id,
      subjectUserId: after.userId,
      before: snapshot(before),
      after: snapshot(after),
    },
    event: { companyId: after.companyId, type: LEAVE_REASSIGNED_EVENT_TYPE, payload },
  });
}

/**
 * Writes the audit row (`leave_request.recounted`) and the `leave.recounted` event for a
 * request whose day count changed with the company calendar, inside `tx`.
 */
export async function recordRecount(
  tx: Transaction,
  change: { before: LeaveRequestRow; after: LeaveRequestRow; source: PersonChangeSource },
): Promise<void> {
  const { before, after, source } = change;
  const payload: LeaveRecountedPayload = { ...leaveEventPayload(after, source), previousDays: before.days };
  await recordChange(tx, {
    source,
    audit: {
      companyId: after.companyId,
      action: leaveAuditAction("recounted"),
      entityType: "leave_request",
      entityId: after.id,
      subjectUserId: after.userId,
      before: snapshot(before),
      after: snapshot(after),
    },
    event: { companyId: after.companyId, type: LEAVE_RECOUNTED_EVENT_TYPE, payload },
  });
}

/** Active recipients by id, so a deactivated person is never emailed. */
export async function activeContacts(tx: Transaction, companyId: string, ids: readonly (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const rows = await findContacts(tx, companyId, wanted);
  return new Map(rows.filter((r) => r.isActive).map((r) => [r.id, r]));
}

/**
 * The request as an email shows it.
 *
 * @param requester The requester's contact, if active; names them in other people's mail.
 */
export function summarize(
  row: LeaveRequestRow,
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
