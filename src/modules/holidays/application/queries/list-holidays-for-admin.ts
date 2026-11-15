import "server-only";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { yearInTimeZone } from "@/lib/dates";
import type { ServiceContext } from "@/server/context";
import { listHolidayRows } from "@/modules/calendar";
import { findCompany } from "@/modules/organisation";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { type HolidayYearDTO, toHolidayDTO } from "@/modules/holidays/application/dto";
import { assertYear } from "@/modules/holidays/application/holiday-changes";
import { canManageHolidays } from "@/modules/holidays/application/policies";

/**
 * The company's holidays in `year` (default: the current year in the company's time
 * zone), by date. Fails with `forbidden`, `no_company` or `invalid_input`.
 */
export async function listHolidaysForAdmin(ctx: ServiceContext, actor: Actor, year?: number): Promise<ServiceResult<HolidayYearDTO>> {
  if (!canManageHolidays(actor)) return err("forbidden");
  return attempt(async () => {
    let shown = year;
    if (shown === undefined) {
      const company = await findCompany(ctx.db, actor.companyId);
      if (!company) throw new DomainError("no_company");
      shown = yearInTimeZone(company.timezone, ctx.now());
    }
    assertYear(shown);
    const rows = await listHolidayRows(ctx.db, actor.companyId, `${shown}-01-01`, `${shown}-12-31`);
    return { year: shown, holidays: rows.map(toHolidayDTO) };
  });
}
