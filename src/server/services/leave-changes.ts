import type { Transaction } from "@/db/types";
import { LEAVE_EVENT_TYPES, leaveAuditAction, leaveEventPayload } from "@/domain/events";
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
 */
export async function recordLeaveChange(
  tx: Transaction,
  change: {
    event: keyof typeof LEAVE_EVENT_TYPES;
    before: LeaveRequestRow | null;
    after: LeaveRequestRow;
    actorId: string;
  },
): Promise<void> {
  const { after, actorId } = change;
  await recordChange(tx, {
    audit: {
      companyId: after.companyId,
      actorId,
      action: leaveAuditAction(change.event),
      entityType: "leave_request",
      entityId: after.id,
      before: change.before ? snapshot(change.before) : null,
      after: snapshot(after),
    },
    event: {
      companyId: after.companyId,
      type: LEAVE_EVENT_TYPES[change.event],
      payload: leaveEventPayload(after, actorId),
    },
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
