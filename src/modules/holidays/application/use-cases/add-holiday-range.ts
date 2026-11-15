import "server-only";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES } from "@/domain/events";
import { normalizeHolidayName } from "@/domain/holidays";
import type { ServiceContext } from "@/server/context";
import { recountLeave } from "@/modules/leave";
import { commitThenNotify } from "@/modules/notifications";
import { attempt, err, type ServiceResult, unwrap } from "@/shared/lib/result";
import { holidayRangeDates } from "@/modules/holidays/domain/holiday-range";
import { insertHolidays } from "@/modules/holidays/infrastructure/drizzle-holidays.repository";
import { type AddedHolidayRangeDTO, toHolidayDTO } from "@/modules/holidays/application/dto";
import { assertYear, beginCalendarChange, holidayFact, recordHolidayChange } from "@/modules/holidays/application/holiday-changes";
import { canManageHolidays } from "@/modules/holidays/application/policies";

/**
 * Adds one holiday on every day from `startDate` to `endDate` (weekends included), all
 * named alike, and recounts the requests on them once, together. Days that already
 * have a holiday keep theirs and are skipped. Each added day is audited and gets its
 * own `holiday.created` event, exactly as if it had been added alone.
 *
 * Fails with `forbidden`, `invalid_input` (bad dates, end before start, a run too long,
 * or a year out of range), `already_exists` (every day already has a holiday),
 * `no_company`, or as `recountLeave`.
 */
export async function addHolidayRange(
  ctx: ServiceContext,
  actor: Actor,
  input: { startDate: string; endDate: string; name: string },
): Promise<ServiceResult<AddedHolidayRangeDTO>> {
  if (!canManageHolidays(actor)) return err("forbidden");
  return attempt(async () => {
    const dates = holidayRangeDates(input.startDate, input.endDate);
    assertYear(Number(input.startDate.slice(0, 4)));
    assertYear(Number(input.endDate.slice(0, 4)));
    const name = normalizeHolidayName(input.name);
    return commitThenNotify(ctx, actor.companyId, async (tx) => {
      await beginCalendarChange(tx, actor);
      const added = (
        await insertHolidays(
          tx,
          actor.companyId,
          dates.map((date) => ({ date, name })),
        )
      ).map(toHolidayDTO);
      if (added.length === 0) throw new DomainError("already_exists", "Every one of those days already has a holiday.");
      for (const holiday of added) await recordHolidayChange(tx, actor, ADMIN_EVENT_TYPES.holidayCreated, { before: null, after: holiday });
      const taken = new Set(added.map((holiday) => holiday.date));
      const skipped = dates.filter((date) => !taken.has(date));
      const { outcome, notify } = unwrap(await recountLeave(tx, ctx, actor, { kind: "holidays", added: added.map(holidayFact), removed: [] }));
      return { result: { added, skipped, recount: outcome }, notify };
    });
  });
}
