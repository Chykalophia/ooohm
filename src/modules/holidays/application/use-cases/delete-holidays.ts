import "server-only";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES } from "@/domain/events";
import type { ServiceContext } from "@/server/context";
import { type RecountOutcome, recountLeave } from "@/modules/leave";
import { commitThenNotify } from "@/modules/notifications";
import { attempt, err, type ServiceResult, unwrap } from "@/shared/lib/result";
import { deleteHolidays as deleteHolidayRows } from "@/modules/holidays/infrastructure/drizzle-holidays.repository";
import { toHolidayDTO } from "@/modules/holidays/application/dto";
import { beginCalendarChange, checkIds, holidayFact, recordHolidayChange } from "@/modules/holidays/application/holiday-changes";
import { canManageHolidays } from "@/modules/holidays/application/policies";

/**
 * Deletes holidays together (every day of a run), each audited, and recounts the
 * requests on their dates once, in the same transaction.
 *
 * @returns The recount. Fails with `forbidden`, `not_found` (any of them gone, or
 *   another company's; nothing is deleted then), `no_company`, or as `recountLeave`.
 */
export async function deleteHolidays(ctx: ServiceContext, actor: Actor, ids: readonly string[]): Promise<ServiceResult<RecountOutcome>> {
  if (!canManageHolidays(actor)) return err("forbidden");
  return attempt(async () => {
    const wanted = checkIds(ids);
    return commitThenNotify(ctx, actor.companyId, async (tx) => {
      await beginCalendarChange(tx, actor);
      const deleted = (await deleteHolidayRows(tx, actor.companyId, wanted)).map(toHolidayDTO);
      if (deleted.length !== wanted.length) throw new DomainError("not_found");
      for (const holiday of deleted) await recordHolidayChange(tx, actor, ADMIN_EVENT_TYPES.holidayDeleted, { before: holiday, after: null });
      const { outcome, notify } = unwrap(await recountLeave(tx, ctx, actor, { kind: "holidays", added: [], removed: deleted.map(holidayFact) }));
      return { result: outcome, notify };
    });
  });
}
