/**
 * Admin use cases for company holidays: list a year, add one day or a run of days (an
 * end-of-year shutdown), rename, delete, and add the US federal holidays for a year in
 * one step.
 *
 * A holiday is stored one row per day, so day counting, the calendar and the API never
 * see ranges. A run added together shares one name; the admin screen shows back-to-back
 * days with one name as one entry ({@link groupHolidays}) and renames or deletes them
 * together, by their ids.
 *
 * Adding or deleting a holiday recounts the pending and approved requests on that date
 * in years still open ({@link recountLeave}): a request that falls on a new holiday
 * costs a day less, one on a deleted holiday a day more, and the people affected are
 * emailed. Past years keep their counts, so a settled balance never moves. Renaming
 * changes no count.
 */
import type { Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { assertCanAdminister } from "@/domain/admin-permissions";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES, type AdminEventType, type HolidayEventPayload, type Unattributed } from "@/domain/events";
import { assertHolidayDate, holidayRangeDates, isHolidayYear, normalizeHolidayName, usFederalHolidays } from "@/domain/holidays";
import { isUuid } from "@/domain/ids";
import { yearInTimeZone } from "@/lib/dates";
import type { ServiceContext } from "@/server/context";
import { findCompany, lockCompany } from "@/server/repositories/companies";
import { isUniqueViolation } from "@/server/repositories/errors";
import {
  deleteHolidays as deleteHolidayRows,
  findHolidays,
  type HolidayRow,
  insertHolidays,
  listHolidayRows,
  renameHolidays as renameHolidayRows,
} from "@/server/repositories/holidays";
import { assertActiveAdmin, recordAdminChange } from "./admin-access";
import { type HolidayFact, type RecountOutcome, recountLeave } from "./leave-recount";
import { commitThenNotify, inTransaction } from "./notify";

function payload(row: HolidayRow): Unattributed<HolidayEventPayload> {
  return { holidayId: row.id, date: row.date, name: row.name };
}

/** A created holiday has no `before`; a deleted one has no `after`. */
type HolidayChange = { before: null; after: HolidayRow } | { before: HolidayRow; after: HolidayRow | null };

async function record(tx: Transaction, actor: Actor, type: AdminEventType, change: HolidayChange) {
  const { before, after } = change;
  // The holiday as it is now, or as it was when deleted.
  const row = change.before === null ? change.after : (change.after ?? change.before);
  await recordAdminChange(tx, actor, {
    type,
    entityType: "holiday",
    entityId: row.id,
    before: before ? { date: before.date, name: before.name } : null,
    after: after ? { date: after.date, name: after.name } : null,
    payload: payload(row),
  });
}

/** @throws DomainError `invalid_input` for a year outside the supported range. */
function assertYear(year: number): void {
  if (!isHolidayYear(year)) throw new DomainError("invalid_input", "That year isn't available.");
}

/**
 * The company's holidays in `year` (default: the current year in the company's time
 * zone), by date.
 *
 * @throws DomainError `forbidden`, `no_company` or `invalid_input`.
 */
export async function listHolidaysForAdmin(ctx: ServiceContext, actor: Actor, year?: number): Promise<{ year: number; holidays: HolidayRow[] }> {
  assertCanAdminister(actor);
  let shown = year;
  if (shown === undefined) {
    const company = await findCompany(ctx.db, actor.companyId);
    if (!company) throw new DomainError("no_company");
    shown = yearInTimeZone(company.timezone, ctx.now());
  }
  assertYear(shown);
  return { year: shown, holidays: await listHolidayRows(ctx.db, actor.companyId, `${shown}-01-01`, `${shown}-12-31`) };
}

/** Locks the company for a change that recounts several people's leave, and checks the admin. */
async function beginCalendarChange(tx: Transaction, actor: Actor): Promise<void> {
  if (!(await lockCompany(tx, actor.companyId))) throw new DomainError("no_company");
  await assertActiveAdmin(tx, actor);
}

const fact = (row: HolidayRow): HolidayFact => ({ date: row.date, name: row.name });

/**
 * Adds a holiday and recounts the requests on its date.
 *
 * @throws DomainError `forbidden`, `invalid_input`, `already_exists` (a holiday on that
 *   date), or as {@link recountLeave}.
 */
export async function addHoliday(
  ctx: ServiceContext,
  actor: Actor,
  input: { date: string; name: string },
): Promise<{ holiday: HolidayRow; recount: RecountOutcome }> {
  assertCanAdminister(actor);
  assertHolidayDate(input.date);
  assertYear(Number(input.date.slice(0, 4)));
  const name = normalizeHolidayName(input.name);
  try {
    return await commitThenNotify(ctx, actor.companyId, async (tx) => {
      await beginCalendarChange(tx, actor);
      const [row] = await insertHolidays(tx, actor.companyId, [{ date: input.date, name }]);
      if (!row) throw new DomainError("already_exists");
      await record(tx, actor, ADMIN_EVENT_TYPES.holidayCreated, { before: null, after: row });
      const { outcome, notify } = await recountLeave(tx, ctx, actor, { kind: "holidays", added: [fact(row)], removed: [] });
      return { result: { holiday: row, recount: outcome }, notify };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError("already_exists");
    throw err;
  }
}

/**
 * Adds one holiday on every day from `startDate` to `endDate` (weekends included), all
 * named alike, and recounts the requests on them once, together. Days that already
 * have a holiday keep theirs and are skipped. Each added day is audited and gets its
 * own `holiday.created` event, exactly as if it had been added alone.
 *
 * @returns The days added and the dates skipped.
 * @throws DomainError `forbidden`, `invalid_input` (bad dates, end before start, a run
 *   too long, or a year out of range), `already_exists` (every day already has a
 *   holiday), or as {@link recountLeave}.
 */
export async function addHolidayRange(
  ctx: ServiceContext,
  actor: Actor,
  input: { startDate: string; endDate: string; name: string },
): Promise<{ added: HolidayRow[]; skipped: string[]; recount: RecountOutcome }> {
  assertCanAdminister(actor);
  const dates = holidayRangeDates(input.startDate, input.endDate);
  assertYear(Number(input.startDate.slice(0, 4)));
  assertYear(Number(input.endDate.slice(0, 4)));
  const name = normalizeHolidayName(input.name);
  return commitThenNotify(ctx, actor.companyId, async (tx) => {
    await beginCalendarChange(tx, actor);
    const added = await insertHolidays(
      tx,
      actor.companyId,
      dates.map((date) => ({ date, name })),
    );
    if (added.length === 0) throw new DomainError("already_exists", "Every one of those days already has a holiday.");
    for (const row of added) await record(tx, actor, ADMIN_EVENT_TYPES.holidayCreated, { before: null, after: row });
    const taken = new Set(added.map((row) => row.date));
    const skipped = dates.filter((date) => !taken.has(date));
    const { outcome, notify } = await recountLeave(tx, ctx, actor, { kind: "holidays", added: added.map(fact), removed: [] });
    return { result: { added, skipped, recount: outcome }, notify };
  });
}

/**
 * Adds every US federal holiday observed in `year` that falls on a date without a
 * holiday yet; dates already taken keep theirs. Each added holiday is audited, and the
 * requests on their dates are recounted once, together.
 *
 * @returns The holidays added (none when all were there already) and the recount.
 * @throws DomainError `forbidden`, `invalid_input`, or as {@link recountLeave}.
 */
export async function addUsFederalHolidays(
  ctx: ServiceContext,
  actor: Actor,
  year: number,
): Promise<{ added: HolidayRow[]; recount: RecountOutcome }> {
  assertCanAdminister(actor);
  assertYear(year);
  return commitThenNotify(ctx, actor.companyId, async (tx) => {
    await beginCalendarChange(tx, actor);
    const added = await insertHolidays(tx, actor.companyId, usFederalHolidays(year));
    for (const row of added) await record(tx, actor, ADMIN_EVENT_TYPES.holidayCreated, { before: null, after: row });
    const { outcome, notify } = await recountLeave(tx, ctx, actor, { kind: "holidays", added: added.map(fact), removed: [] });
    return { result: { added, recount: outcome }, notify };
  });
}

/** The ids an admin acts on together: a day, or every day of a run. */
function checkIds(ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0 || !unique.every(isUuid)) throw new DomainError("not_found");
  return unique;
}

/** @throws DomainError `forbidden`, `not_found`, or `invalid_input`. */
export async function renameHoliday(ctx: ServiceContext, actor: Actor, id: string, rawName: string): Promise<HolidayRow> {
  const [row] = await renameHolidays(ctx, actor, [id], rawName);
  if (!row) throw new DomainError("not_found");
  return row;
}

/**
 * Renames holidays together (every day of a run), each audited. Days already called
 * that are left alone.
 *
 * @returns The holidays as they are now, by date.
 * @throws DomainError `forbidden`, `not_found` (any of them gone, or another
 *   company's), or `invalid_input`.
 */
export async function renameHolidays(ctx: ServiceContext, actor: Actor, ids: readonly string[], rawName: string): Promise<HolidayRow[]> {
  assertCanAdminister(actor);
  const wanted = checkIds(ids);
  const name = normalizeHolidayName(rawName);
  return inTransaction(ctx, async (tx) => {
    await assertActiveAdmin(tx, actor);
    const before = await findHolidays(tx, actor.companyId, wanted);
    if (before.length !== wanted.length) throw new DomainError("not_found");
    const changing = before.filter((row) => row.name !== name);
    const after = await renameHolidayRows(
      tx,
      actor.companyId,
      changing.map((row) => row.id),
      name,
    );
    if (after.length !== changing.length) throw new DomainError("not_found");
    const renamed = new Map(after.map((row) => [row.id, row]));
    for (const row of changing) await record(tx, actor, ADMIN_EVENT_TYPES.holidayRenamed, { before: row, after: renamed.get(row.id)! });
    return before.map((row) => renamed.get(row.id) ?? row);
  });
}

/**
 * Deletes a holiday and recounts the requests on its date.
 *
 * @returns The recount.
 * @throws DomainError `forbidden`, `not_found`, or as {@link recountLeave}.
 */
export async function deleteHoliday(ctx: ServiceContext, actor: Actor, id: string): Promise<RecountOutcome> {
  return deleteHolidays(ctx, actor, [id]);
}

/**
 * Deletes holidays together (every day of a run), each audited, and recounts the
 * requests on their dates once.
 *
 * @returns The recount.
 * @throws DomainError `forbidden`, `not_found` (any of them gone, or another
 *   company's; nothing is deleted then), or as {@link recountLeave}.
 */
export async function deleteHolidays(ctx: ServiceContext, actor: Actor, ids: readonly string[]): Promise<RecountOutcome> {
  assertCanAdminister(actor);
  const wanted = checkIds(ids);
  return commitThenNotify(ctx, actor.companyId, async (tx) => {
    await beginCalendarChange(tx, actor);
    const deleted = await deleteHolidayRows(tx, actor.companyId, wanted);
    if (deleted.length !== wanted.length) throw new DomainError("not_found");
    for (const row of deleted) await record(tx, actor, ADMIN_EVENT_TYPES.holidayDeleted, { before: row, after: null });
    const { outcome, notify } = await recountLeave(tx, ctx, actor, { kind: "holidays", added: [], removed: deleted.map(fact) });
    return { result: outcome, notify };
  });
}
