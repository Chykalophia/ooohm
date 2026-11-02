import type { Transaction } from "@/db/types";
import type { ChangeSource } from "@/domain/change-source";
import {
  ALLOWANCE_AUDIT_ACTIONS,
  BALANCE_EVENT_TYPES,
  type BalanceAdjustedPayload,
  type BalanceChangeReason,
  type Unattributed,
} from "@/domain/events";
import type { AllowanceRow } from "@/server/repositories/balances";
import { recordChange } from "@/server/repositories/change-log";

/** The audited view of an allowance row. */
function allowanceSnapshot(row: AllowanceRow) {
  return {
    userId: row.userId,
    leaveTypeId: row.leaveTypeId,
    year: row.year,
    days: row.days,
    carriedOverDays: row.carriedOverDays,
    adjustmentDays: row.adjustmentDays,
  };
}

/**
 * Writes the audit row and the `balance.adjusted` event for one allowance change,
 * inside `tx`. Shared by the year rollover (a system source), the admin allowance editor
 * and the inbound sync.
 *
 * @param change.note The admin's reason, kept in the audit row's `after` only: it is
 *   free text about a person, and the outbox payload goes to other systems.
 */
export async function recordAllowanceChange(
  tx: Transaction,
  change: {
    companyId: string;
    reason: BalanceChangeReason;
    before: AllowanceRow | null;
    after: AllowanceRow;
    source: ChangeSource;
    note?: string;
  },
): Promise<void> {
  const { after } = change;
  const payload: Unattributed<BalanceAdjustedPayload> = {
    allowanceId: after.id,
    userId: after.userId,
    leaveTypeId: after.leaveTypeId,
    year: after.year,
    days: after.days,
    carriedOverDays: after.carriedOverDays,
    adjustmentDays: after.adjustmentDays,
    reason: change.reason,
  };
  await recordChange(tx, {
    source: change.source,
    audit: {
      companyId: change.companyId,
      action: ALLOWANCE_AUDIT_ACTIONS[change.reason],
      entityType: "allowance",
      entityId: after.id,
      subjectUserId: after.userId,
      before: change.before ? allowanceSnapshot(change.before) : null,
      after: change.note === undefined ? allowanceSnapshot(after) : { ...allowanceSnapshot(after), reason: change.note },
    },
    event: { companyId: change.companyId, type: BALANCE_EVENT_TYPES.adjusted, payload },
  });
}
