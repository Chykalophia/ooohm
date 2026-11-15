import "server-only";
/**
 * What every holiday change shares: its audit row and event, the company lock a recount
 * takes, and the checks on years and ids.
 *
 * A holiday is stored one row per day, so day counting, the calendar and the API never
 * see ranges. Adding or deleting a holiday recounts the pending and approved requests on
 * that date in years still open (`recountLeave` in `@/modules/leave`), in the same
 * transaction: a request that falls on a new holiday costs a day less, one on a deleted
 * holiday a day more, and the people affected are emailed after commit. Past years keep
 * their counts, so a settled balance never moves. Renaming changes no count.
 */
import type { Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import type { AdminEventType, HolidayEventPayload, Unattributed } from "@/domain/events";
import { isHolidayYear } from "@/domain/holidays";
import { isUuid } from "@/domain/ids";
import type { HolidayFact } from "@/modules/leave";
import { assertActiveAdmin, recordAdminChange } from "@/shared/lib/admin-access";
import { lockCompany } from "@/shared/lib/db/company-lock";
import type { HolidayDTO } from "@/modules/holidays/application/dto";

function payload(holiday: HolidayDTO): Unattributed<HolidayEventPayload> {
  return { holidayId: holiday.id, date: holiday.date, name: holiday.name };
}

/** A created holiday has no `before`; a deleted one has no `after`. */
export type HolidayChange = { before: null; after: HolidayDTO } | { before: HolidayDTO; after: HolidayDTO | null };

/** Writes the change's audit row and its `holiday.*` event. */
export async function recordHolidayChange(tx: Transaction, actor: Actor, type: AdminEventType, change: HolidayChange): Promise<void> {
  const { before, after } = change;
  // The holiday as it is now, or as it was when deleted.
  const holiday = change.before === null ? change.after : (change.after ?? change.before);
  await recordAdminChange(tx, actor, {
    type,
    entityType: "holiday",
    entityId: holiday.id,
    before: before ? { date: before.date, name: before.name } : null,
    after: after ? { date: after.date, name: after.name } : null,
    payload: payload(holiday),
  });
}

/** @throws DomainError `invalid_input` for a year outside the supported range. */
export function assertYear(year: number): void {
  if (!isHolidayYear(year)) throw new DomainError("invalid_input", "That year isn't available.");
}

/** Locks the company for a change that recounts several people's leave, and checks the admin. */
export async function beginCalendarChange(tx: Transaction, actor: Actor): Promise<void> {
  if (!(await lockCompany(tx, actor.companyId))) throw new DomainError("no_company");
  await assertActiveAdmin(tx, actor);
}

/** A holiday as the leave recount reads it. */
export const holidayFact = (holiday: HolidayDTO): HolidayFact => ({ date: holiday.date, name: holiday.name });

/** The ids an admin acts on together: a day, or every day of a run. */
export function checkIds(ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0 || !unique.every(isUuid)) throw new DomainError("not_found");
  return unique;
}
