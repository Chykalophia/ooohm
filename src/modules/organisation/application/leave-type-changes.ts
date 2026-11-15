import "server-only";
import type { Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import type { AdminEventType, LeaveTypeEventPayload, Unattributed } from "@/domain/events";
import { recordAdminChange } from "@/shared/lib/admin-access";
import { isUniqueViolation } from "@/shared/lib/db/errors";
import type { LeaveTypeSettingsDTO } from "@/modules/organisation/application/dto";

/** The audited view of a leave type. */
function snapshot(row: LeaveTypeSettingsDTO) {
  return {
    name: row.name,
    code: row.code,
    color: row.color,
    isPaid: row.isPaid,
    countsAgainstAllowance: row.countsAgainstAllowance,
    defaultAllowanceDays: row.defaultAllowanceDays,
    carryoverEnabled: row.carryoverEnabled,
    carryoverMaxDays: row.carryoverMaxDays,
    sortOrder: row.sortOrder,
    archived: row.archivedAt !== null,
  };
}

function payload(row: LeaveTypeSettingsDTO): Unattributed<LeaveTypeEventPayload> {
  return { leaveTypeId: row.id, ...snapshot(row) };
}

/** Records a leave type change: its audit row and its `leave_type.*` event. */
export async function recordLeaveTypeChange(
  tx: Transaction,
  actor: Actor,
  type: AdminEventType,
  before: LeaveTypeSettingsDTO | null,
  after: LeaveTypeSettingsDTO,
): Promise<void> {
  await recordAdminChange(tx, actor, {
    type,
    entityType: "leave_type",
    entityId: after.id,
    before: before ? snapshot(before) : null,
    after: snapshot(after),
    payload: payload(after),
  });
}

/** Runs `work`, turning a code race into `already_exists`. */
export async function withUniqueCode<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (isUniqueViolation(err, "leave_types_company_code_uq")) throw new DomainError("already_exists");
    throw err;
  }
}
