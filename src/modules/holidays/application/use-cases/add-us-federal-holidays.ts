import "server-only";
import type { Actor } from "@/domain/actor";
import { ADMIN_EVENT_TYPES } from "@/domain/events";
import type { ServiceContext } from "@/server/context";
import { recountLeave } from "@/modules/leave";
import { commitThenNotify } from "@/modules/notifications";
import { attempt, err, type ServiceResult, unwrap } from "@/shared/lib/result";
import { usFederalHolidays } from "@/modules/holidays/domain/us-federal-holidays";
import { insertHolidays } from "@/modules/holidays/infrastructure/drizzle-holidays.repository";
import { type AddedFederalHolidaysDTO, toHolidayDTO } from "@/modules/holidays/application/dto";
import { assertYear, beginCalendarChange, holidayFact, recordHolidayChange } from "@/modules/holidays/application/holiday-changes";
import { canManageHolidays } from "@/modules/holidays/application/policies";

/**
 * Adds every US federal holiday observed in `year` that falls on a date without a
 * holiday yet; dates already taken keep theirs. Each added holiday is audited, and the
 * requests on their dates are recounted once, together. Fails with `forbidden`,
 * `invalid_input`, `no_company`, or as `recountLeave`.
 */
export async function addUsFederalHolidays(ctx: ServiceContext, actor: Actor, year: number): Promise<ServiceResult<AddedFederalHolidaysDTO>> {
  if (!canManageHolidays(actor)) return err("forbidden");
  return attempt(async () => {
    assertYear(year);
    return commitThenNotify(ctx, actor.companyId, async (tx) => {
      await beginCalendarChange(tx, actor);
      const added = (await insertHolidays(tx, actor.companyId, usFederalHolidays(year))).map(toHolidayDTO);
      for (const holiday of added) await recordHolidayChange(tx, actor, ADMIN_EVENT_TYPES.holidayCreated, { before: null, after: holiday });
      const { outcome, notify } = unwrap(await recountLeave(tx, ctx, actor, { kind: "holidays", added: added.map(holidayFact), removed: [] }));
      return { result: { added, recount: outcome }, notify };
    });
  });
}
