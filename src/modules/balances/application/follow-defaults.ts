import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import type { AllowanceDefaults } from "../domain/allowance-rules";
import { recordAllowanceChange } from "./allowance-changes";
import type { BalancesStore } from "./ports";

/**
 * Moves the allowance rows that were following their person's default to the new one,
 * after a change to the rules or to where people sit (department, level): each row of
 * `userIds` for `fromYear` or later (closed years stay as they were settled) whose
 * `days` equal its default `before` the change takes its default `after`, when that
 * differs and is not "no default". Rows set to anything else were set by hand and stay.
 *
 * Each move writes `allowance.rule_applied` and `balance.adjusted` (`reason:
 * "allowance_rule"`), attributed to `actor`. The rows are locked first, so a submit in
 * flight either sees the new allowance or finishes first.
 *
 * @returns How many rows moved.
 */
export async function followDefaults(
  store: BalancesStore,
  actor: Actor,
  change: { userIds: readonly string[]; leaveTypeIds?: readonly string[]; fromYear: number; before: AllowanceDefaults; after: AllowanceDefaults },
): Promise<number> {
  const rows = await store.allowances.lockFrom({ userIds: change.userIds, fromYear: change.fromYear, leaveTypeIds: change.leaveTypeIds });
  if (rows.length === 0) return 0;
  const types = new Map((await store.directory.allLeaveTypes(actor.companyId)).map((t) => [t.id, t]));
  let moved = 0;
  for (const row of rows) {
    const type = types.get(row.leaveTypeId);
    if (!type) continue;
    const before = change.before(row.userId, type);
    const after = change.after(row.userId, type);
    if (before === null || after === null || before === after || row.days !== before) continue;
    const updated = await store.allowances.setDays(row.id, after);
    await recordAllowanceChange(store.changes, { companyId: actor.companyId, reason: "allowance_rule", before: row, after: updated, source: actor.source });
    moved++;
  }
  return moved;
}
