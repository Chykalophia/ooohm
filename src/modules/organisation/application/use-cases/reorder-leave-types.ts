import "server-only";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES } from "@/domain/events";
import { isUuid } from "@/domain/ids";
import type { ServiceContext } from "@/server/context";
import { assertActiveAdmin } from "@/shared/lib/admin-access";
import { lockCompany } from "@/shared/lib/db/company-lock";
import { inTransaction } from "@/shared/lib/unit-of-work";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { listAllLeaveTypes, updateLeaveType as updateLeaveTypeRow } from "@/modules/organisation/infrastructure/drizzle-leave-types.repository";
import { toLeaveTypeSettingsDTO } from "@/modules/organisation/application/dto";
import { recordLeaveTypeChange } from "@/modules/organisation/application/leave-type-changes";
import { canManageLeaveTypes } from "@/modules/organisation/application/policies";

/** The most active leave types a reorder takes: far more than any company has. */
const REORDER_MAX = 200;

/**
 * Puts the active leave types in the request form in `order` (their ids, first to last),
 * as dragged on the leave types page, then numbers them 0, 1, 2... Each type whose
 * position changed writes a `leave_type.reordered` audit row and event; a type already
 * in its place writes nothing. The first type is the form's default.
 *
 * `order` must name every active type exactly once: when it does not, the list changed
 * since the page loaded (a type added, archived or restored meanwhile) and nothing moves.
 *
 * Returns whether anything moved. Fails with `forbidden`, `no_company`, `invalid_input`
 * (not a list of distinct ids), or `conflict` (not exactly the active types).
 */
export async function reorderLeaveTypes(ctx: ServiceContext, actor: Actor, order: readonly string[]): Promise<ServiceResult<boolean>> {
  if (!canManageLeaveTypes(actor)) return err("forbidden");
  if (order.length === 0 || order.length > REORDER_MAX || !order.every(isUuid) || new Set(order).size !== order.length) {
    return err("invalid_input");
  }
  return attempt(() =>
    inTransaction(ctx, async (tx) => {
      // Serialises reorders, so two at once cannot interleave their renumbering.
      if (!(await lockCompany(tx, actor.companyId))) throw new DomainError("no_company");
      await assertActiveAdmin(tx, actor);
      const active = new Map(
        (await listAllLeaveTypes(tx, actor.companyId)).filter((t) => t.archivedAt === null).map((t) => [t.id, toLeaveTypeSettingsDTO(t)]),
      );
      if (active.size !== order.length || !order.every((id) => active.has(id))) throw new DomainError("conflict");
      let moved = false;
      for (const [position, id] of order.entries()) {
        const before = active.get(id)!;
        if (before.sortOrder === position) continue;
        const after = toLeaveTypeSettingsDTO(await updateLeaveTypeRow(tx, actor.companyId, id, { sortOrder: position }));
        await recordLeaveTypeChange(tx, actor, ADMIN_EVENT_TYPES.leaveTypeReordered, before, after);
        moved = true;
      }
      return moved;
    }),
  );
}
