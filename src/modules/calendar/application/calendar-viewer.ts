import "server-only";
import { forTenant } from "@/shared/lib/tenant";
import type { Actor } from "@/shared/kernel/actor";
import { addMonths, isYearMonth, monthOf, type YearMonth } from "@/shared/kernel/calendar";
import { DomainError } from "@/shared/kernel/errors";
import type { ServiceContext } from "@/server/context";
import { findCalendarViewer } from "@/modules/calendar/infrastructure/drizzle-calendar.repository";
import { scopeOf } from "@/modules/calendar/application/calendar-scope";

/** Where a month view sits and where its links go. */
export interface MonthNav {
  month: YearMonth;
  /** Today in the company's time zone. */
  today: string;
  previous: YearMonth;
  next: YearMonth;
  /** The month holding today, the target of the "Today" link. */
  current: YearMonth;
}

export function monthNav(requested: string | undefined, today: string): MonthNav {
  const current = monthOf(today);
  const month = requested !== undefined && isYearMonth(requested) ? requested : current;
  return { month, today, previous: addMonths(month, -1), next: addMonths(month, 1), current };
}

/** Where a year view sits and where its links go. */
export interface YearNav {
  year: number;
  /** Today in the company's time zone. */
  today: string;
  /** The year holding today, the target of the "This year" link. */
  current: number;
}

/**
 * The scope (`calendarScopeFor`) of whoever is looking, from one query that also reads
 * the company's calendar settings.
 *
 * @throws DomainError `no_company` when the actor's company is missing.
 */
export async function calendarViewer(ctx: ServiceContext, actor: Actor) {
  ctx = forTenant(ctx, actor.companyId);
  const viewer = await findCalendarViewer(ctx.db, actor.companyId, actor.id);
  if (!viewer) throw new DomainError("no_company");
  const person = { id: actor.id, role: actor.role, managerId: viewer.managerId, departmentId: viewer.departmentId };
  return { settings: viewer, person, scope: await scopeOf(ctx.db, actor.companyId, person, viewer) };
}
