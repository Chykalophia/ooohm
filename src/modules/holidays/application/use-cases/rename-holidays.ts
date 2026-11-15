import "server-only";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES } from "@/domain/events";
import { normalizeHolidayName } from "@/domain/holidays";
import type { ServiceContext } from "@/server/context";
import { assertActiveAdmin } from "@/shared/lib/admin-access";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { inTransaction } from "@/shared/lib/unit-of-work";
import { findHolidays, renameHolidays as renameHolidayRows } from "@/modules/holidays/infrastructure/drizzle-holidays.repository";
import { type HolidayDTO, toHolidayDTO } from "@/modules/holidays/application/dto";
import { checkIds, recordHolidayChange } from "@/modules/holidays/application/holiday-changes";
import { canManageHolidays } from "@/modules/holidays/application/policies";

/**
 * Renames holidays together (every day of a run), each audited. Days already called
 * that are left alone. Renaming changes no count, so nothing is recounted.
 *
 * @returns The holidays as they are now, by date. Fails with `forbidden`, `not_found`
 *   (any of them gone, or another company's), or `invalid_input`.
 */
export async function renameHolidays(ctx: ServiceContext, actor: Actor, ids: readonly string[], rawName: string): Promise<ServiceResult<HolidayDTO[]>> {
  if (!canManageHolidays(actor)) return err("forbidden");
  return attempt(async () => {
    const wanted = checkIds(ids);
    const name = normalizeHolidayName(rawName);
    return inTransaction(ctx, async (tx) => {
      await assertActiveAdmin(tx, actor);
      const before = (await findHolidays(tx, actor.companyId, wanted)).map(toHolidayDTO);
      if (before.length !== wanted.length) throw new DomainError("not_found");
      const changing = before.filter((holiday) => holiday.name !== name);
      const after = await renameHolidayRows(
        tx,
        actor.companyId,
        changing.map((holiday) => holiday.id),
        name,
      );
      if (after.length !== changing.length) throw new DomainError("not_found");
      const renamed = new Map(after.map((row) => [row.id, toHolidayDTO(row)]));
      for (const holiday of changing) {
        await recordHolidayChange(tx, actor, ADMIN_EVENT_TYPES.holidayRenamed, { before: holiday, after: renamed.get(holiday.id)! });
      }
      return before.map((holiday) => renamed.get(holiday.id) ?? holiday);
    });
  });
}
