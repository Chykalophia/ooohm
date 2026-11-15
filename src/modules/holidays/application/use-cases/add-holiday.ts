import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { DomainError } from "@/shared/kernel/errors";
import { ADMIN_EVENT_TYPES } from "@/shared/kernel/events";
import { assertHolidayDate, normalizeHolidayName } from "@/shared/kernel/holidays";
import type { ServiceContext } from "@/server/context";
import { recountLeave } from "@/modules/leave";
import { commitThenNotify } from "@/modules/notifications";
import { isUniqueViolation } from "@/shared/lib/db/errors";
import { attempt, err, type ServiceResult, unwrap } from "@/shared/lib/result";
import { insertHolidays } from "@/modules/holidays/infrastructure/drizzle-holidays.repository";
import { type AddedHolidayDTO, toHolidayDTO } from "@/modules/holidays/application/dto";
import { assertYear, beginCalendarChange, holidayFact, recordHolidayChange } from "@/modules/holidays/application/holiday-changes";
import { canManageHolidays } from "@/modules/holidays/application/policies";

/**
 * Adds a holiday and recounts the requests on its date, in the same transaction. Fails
 * with `forbidden`, `invalid_input`, `already_exists` (a holiday on that date),
 * `no_company`, or as `recountLeave`.
 */
export async function addHoliday(ctx: ServiceContext, actor: Actor, input: { date: string; name: string }): Promise<ServiceResult<AddedHolidayDTO>> {
  if (!canManageHolidays(actor)) return err("forbidden");
  return attempt(async () => {
    assertHolidayDate(input.date);
    assertYear(Number(input.date.slice(0, 4)));
    const name = normalizeHolidayName(input.name);
    try {
      return await commitThenNotify(ctx, actor.companyId, async (tx) => {
        await beginCalendarChange(tx, actor);
        const [row] = await insertHolidays(tx, actor.companyId, [{ date: input.date, name }]);
        if (!row) throw new DomainError("already_exists");
        const holiday = toHolidayDTO(row);
        await recordHolidayChange(tx, actor, ADMIN_EVENT_TYPES.holidayCreated, { before: null, after: holiday });
        const { outcome, notify } = unwrap(await recountLeave(tx, ctx, actor, { kind: "holidays", added: [holidayFact(holiday)], removed: [] }));
        return { result: { holiday, recount: outcome }, notify };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError("already_exists");
      throw error;
    }
  });
}
