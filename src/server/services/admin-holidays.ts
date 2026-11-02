/**
 * Admin use cases for company holidays: list a year, add, rename, delete, and add the
 * US federal holidays for a year in one step.
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
import { assertHolidayDate, isHolidayYear, normalizeHolidayName, usFederalHolidays } from "@/domain/holidays";
import { isUuid } from "@/domain/ids";
import { yearInTimeZone } from "@/lib/dates";
import type { ServiceContext } from "@/server/context";
import { findCompany, lockCompany } from "@/server/repositories/companies";
import { isUniqueViolation } from "@/server/repositories/errors";
import {
  deleteHoliday as deleteHolidayRow,
  findHoliday,
  type HolidayRow,
  insertHolidays,
  listHolidayRows,
  renameHoliday as renameHolidayRow,
} from "@/server/repositories/holidays";
import { assertActiveAdmin, recordAdminChange } from "./admin-access";
import { type HolidayFact, type RecountOutcome, recountLeave } from "./leave-recount";
import { commitThenSend, inTransaction } from "./notify";

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
    return await commitThenSend(ctx, async (tx) => {
      await beginCalendarChange(tx, actor);
      const [row] = await insertHolidays(tx, actor.companyId, [{ date: input.date, name }]);
      if (!row) throw new DomainError("already_exists");
      await record(tx, actor, ADMIN_EVENT_TYPES.holidayCreated, { before: null, after: row });
      const { outcome, outgoing } = await recountLeave(tx, ctx, actor, { kind: "holidays", added: [fact(row)], removed: [] });
      return { result: { holiday: row, recount: outcome }, outgoing };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError("already_exists");
    throw err;
  }
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
  return commitThenSend(ctx, async (tx) => {
    await beginCalendarChange(tx, actor);
    const added = await insertHolidays(tx, actor.companyId, usFederalHolidays(year));
    for (const row of added) await record(tx, actor, ADMIN_EVENT_TYPES.holidayCreated, { before: null, after: row });
    const { outcome, outgoing } = await recountLeave(tx, ctx, actor, { kind: "holidays", added: added.map(fact), removed: [] });
    return { result: { added, recount: outcome }, outgoing };
  });
}

/** @throws DomainError `forbidden`, `not_found`, or `invalid_input`. */
export async function renameHoliday(ctx: ServiceContext, actor: Actor, id: string, rawName: string): Promise<HolidayRow> {
  assertCanAdminister(actor);
  if (!isUuid(id)) throw new DomainError("not_found");
  const name = normalizeHolidayName(rawName);
  return inTransaction(ctx, async (tx) => {
    await assertActiveAdmin(tx, actor);
    const before = await findHoliday(tx, actor.companyId, id);
    if (!before) throw new DomainError("not_found");
    if (before.name === name) return before;
    const after = await renameHolidayRow(tx, actor.companyId, id, name);
    if (!after) throw new DomainError("not_found");
    await record(tx, actor, ADMIN_EVENT_TYPES.holidayRenamed, { before, after });
    return after;
  });
}

/**
 * Deletes a holiday and recounts the requests on its date.
 *
 * @returns The recount.
 * @throws DomainError `forbidden`, `not_found`, or as {@link recountLeave}.
 */
export async function deleteHoliday(ctx: ServiceContext, actor: Actor, id: string): Promise<RecountOutcome> {
  assertCanAdminister(actor);
  if (!isUuid(id)) throw new DomainError("not_found");
  return commitThenSend(ctx, async (tx) => {
    await beginCalendarChange(tx, actor);
    const before = await deleteHolidayRow(tx, actor.companyId, id);
    if (!before) throw new DomainError("not_found");
    await record(tx, actor, ADMIN_EVENT_TYPES.holidayDeleted, { before, after: null });
    const { outcome, outgoing } = await recountLeave(tx, ctx, actor, { kind: "holidays", added: [], removed: [fact(before)] });
    return { result: outcome, outgoing };
  });
}
