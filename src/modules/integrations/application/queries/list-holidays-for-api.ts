import "server-only";
import type { CalendarDate } from "@/shared/kernel/calendar-date";
import { DomainError } from "@/shared/kernel/errors";
import { yearInTimeZone } from "@/lib/dates";
import type { ServiceContext } from "@/server/context";
import { findCompanySettings, listHolidayRows } from "@/modules/calendar";
import { attempt, type ServiceResult } from "@/shared/lib/result";
import { type ApiClient, assertScope } from "@/modules/integrations/domain/integrations";

/**
 * The company's holidays in one year (default: the current year in its time zone), by
 * date. Two queries. Fails with `forbidden`.
 */
export async function listHolidaysForApi(
  ctx: ServiceContext,
  client: ApiClient,
  q: { year?: number | undefined },
): Promise<ServiceResult<{ year: number; data: { id: string; date: CalendarDate; name: string }[] }>> {
  return attempt(async () => {
    assertScope(client, "read");
    const settings = await findCompanySettings(ctx.db, client.companyId);
    if (!settings) throw new DomainError("no_company");
    const year = q.year ?? yearInTimeZone(settings.timezone, ctx.now());
    const rows = await listHolidayRows(ctx.db, client.companyId, `${year}-01-01`, `${year}-12-31`);
    return { year, data: rows.map((h) => ({ id: h.id, date: h.date, name: h.name })) };
  });
}
