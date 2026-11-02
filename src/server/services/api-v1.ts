/**
 * Read use cases of the REST API (`/api/v1`), for an authenticated {@link ApiClient}.
 *
 * Every function checks the `read` scope first and scopes every query by the key's
 * company: an id from another company reads as absent, never as an error that would
 * confirm it exists. Each page costs a fixed number of queries whatever it holds (pinned
 * by `tests/integration/api.test.ts`). Leave request notes and decision notes are never
 * returned: an API key is a company-wide machine credential, and the calendar privacy
 * rule already keeps notes between a person and their approver.
 */
import { resolveAllowancePolicy } from "@/domain/allowance-policy";
import type { CalendarDate } from "@/domain/calendar-date";
import { DomainError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { type ApiClient, assertScope, buildEnvelope, type EventEnvelope } from "@/domain/integrations";
import type { LeaveStatus } from "@/domain/leave-request";
import { yearInTimeZone } from "@/lib/dates";
import type { ServiceContext } from "@/server/context";
import { listBalanceSubjects, listLeaveRequestsPage, listUsersPage } from "@/server/repositories/api-reads";
import { listAllowances, sumBookedDays } from "@/server/repositories/balances";
import { findCompanySettings } from "@/server/repositories/calendar";
import { listHolidayRows } from "@/server/repositories/holidays";
import { listAllLeaveTypes, listLeaveTypesWithAllowance } from "@/server/repositories/leave-types";
import { companyEventExists, listCompanyEvents } from "@/server/repositories/outbox";
import { allowanceYearsFor, balanceInputs } from "./balances";

export const API_DEFAULT_PAGE_SIZE = 100;
export const API_MAX_PAGE_SIZE = 200;

/** A page of a list, and the opaque cursor of the next one (`null` on the last page). */
export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

function encodeCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** @throws DomainError `invalid_input` for a cursor this service did not make. */
function decodeCursor<K extends string>(cursor: string, keys: readonly K[]): Record<K, string> {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (value && typeof value === "object" && keys.every((k) => typeof (value as Record<string, unknown>)[k] === "string")) {
      return value as Record<K, string>;
    }
  } catch {
    // Falls through to the error below.
  }
  throw new DomainError("invalid_input", "That cursor is not valid.");
}

function page<R, T>(rows: readonly R[], limit: number, map: (row: R) => T, cursorOf: (row: R) => Record<string, string>): Page<T> {
  const more = rows.length > limit;
  const shown = more ? rows.slice(0, limit) : rows;
  return { data: shown.map(map), nextCursor: more ? encodeCursor(cursorOf(shown[shown.length - 1])) : null };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function companyYear(ctx: ServiceContext, client: ApiClient, year: number | undefined) {
  const settings = await findCompanySettings(ctx.db, client.companyId);
  if (!settings) throw new DomainError("no_company");
  return { settings, year: year ?? yearInTimeZone(settings.timezone, ctx.now()) };
}

export interface ApiUser {
  id: string;
  name: string;
  email: string;
  department: { id: string; name: string } | null;
  managerId: string | null;
  role: string;
  isActive: boolean;
  createdAt: string;
}

/** People of the company (active and not), by id. One query. */
export async function listUsersForApi(ctx: ServiceContext, client: ApiClient, q: { cursor?: string; limit: number }): Promise<Page<ApiUser>> {
  assertScope(client, "read");
  const after = q.cursor ? decodeCursor(q.cursor, ["id"]).id : undefined;
  const rows = await listUsersPage(ctx.db, { companyId: client.companyId, afterId: after, limit: q.limit });
  return page(
    rows,
    q.limit,
    (r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      department: r.departmentId ? { id: r.departmentId, name: r.departmentName ?? "" } : null,
      managerId: r.managerId,
      role: r.role,
      isActive: r.isActive,
      createdAt: r.createdAt.toISOString(),
    }),
    (r) => ({ id: r.id }),
  );
}

/** Every leave type, archived ones too (flagged), in display order. One query. */
export async function listLeaveTypesForApi(ctx: ServiceContext, client: ApiClient) {
  assertScope(client, "read");
  const rows = await listAllLeaveTypes(ctx.db, client.companyId);
  return {
    data: rows.map((t) => ({
      id: t.id,
      code: t.code,
      name: t.name,
      color: t.color,
      isPaid: t.isPaid,
      countsAgainstAllowance: t.countsAgainstAllowance,
      defaultAllowanceDays: t.defaultAllowanceDays,
      carryoverEnabled: t.carryoverEnabled,
      carryoverMaxDays: t.carryoverMaxDays,
      sortOrder: t.sortOrder,
      archived: t.archivedAt !== null,
    })),
  };
}

export interface LeaveRequestQuery {
  from?: CalendarDate;
  to?: CalendarDate;
  userId?: string;
  status?: LeaveStatus;
  cursor?: string;
  limit: number;
}

/**
 * Leave requests overlapping `[from, to]` (either bound optional), optionally one
 * person's or one status, by start date then id. One query.
 *
 * @throws DomainError `invalid_input` for a bad cursor or `to` before `from`.
 */
export async function listLeaveRequestsForApi(ctx: ServiceContext, client: ApiClient, q: LeaveRequestQuery) {
  assertScope(client, "read");
  if (q.from && q.to && q.to < q.from) throw new DomainError("invalid_input", "`to` is before `from`.");
  let after: { startDate: string; id: string } | undefined;
  if (q.cursor) {
    const c = decodeCursor(q.cursor, ["s", "i"]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.s) || !isUuid(c.i)) throw new DomainError("invalid_input", "That cursor is not valid.");
    after = { startDate: c.s, id: c.i };
  }
  const rows = await listLeaveRequestsPage(ctx.db, { companyId: client.companyId, ...q, after });
  return page(
    rows,
    q.limit,
    (r) => ({
      id: r.id,
      userId: r.userId,
      leaveTypeId: r.leaveTypeId,
      startDate: r.startDate,
      endDate: r.endDate,
      dayPortion: r.dayPortion,
      days: r.days,
      status: r.status,
      approverId: r.approverId,
      decidedAt: iso(r.decidedAt),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }),
    (r) => ({ s: r.startDate, i: r.id }),
  );
}

export interface ApiBalance {
  userId: string;
  leaveTypeId: string;
  year: number;
  /** False for an unlimited type: only `used` and `pending` apply, the rest are `null`. */
  tracked: boolean;
  allowance: number | null;
  carriedOver: number | null;
  adjustment: number | null;
  total: number | null;
  used: number;
  pending: number;
  carriedOut: number | null;
  remaining: number | null;
}

/**
 * Balances for one year (default: the current year in the company's time zone), for
 * every active person, or for one person (active or not), computed exactly as the
 * dashboard computes them. Every active leave type is listed, and an archived one only
 * where the person has an allowance row or booked days for it. Five queries: settings,
 * leave types and people in parallel, then allowance rows and booked-day sums.
 *
 * @throws DomainError `policy_unavailable` when the company's policy is unknown.
 */
export async function listBalancesForApi(ctx: ServiceContext, client: ApiClient, q: { year?: number; userId?: string }) {
  assertScope(client, "read");
  const [settings, types, people] = await Promise.all([
    findCompanySettings(ctx.db, client.companyId),
    listLeaveTypesWithAllowance(ctx.db, client.companyId),
    listBalanceSubjects(ctx.db, client.companyId, q.userId),
  ]);
  if (!settings) throw new DomainError("no_company");
  const policy = resolveAllowancePolicy(settings.allowancePolicy);
  const year = q.year ?? yearInTimeZone(settings.timezone, ctx.now());
  const userIds = people.map((p) => p.id);
  const [allowanceRows, bookedRows] = await Promise.all([
    listAllowances(ctx.db, { userIds, years: allowanceYearsFor([year]) }),
    sumBookedDays(ctx.db, { userIds, years: [year] }),
  ]);
  const inputs = balanceInputs(allowanceRows, bookedRows);
  const data: ApiBalance[] = userIds.flatMap((userId) =>
    types.flatMap((t): ApiBalance[] => {
      if (t.archived && !inputs.allowanceRow(userId, t.id, year) && !inputs.hasBooked(userId, t.id, year)) return [];
      const b = inputs.balance(policy, t, userId, year);
      // Field by field: a field a future policy adds to the domain Balance must not leak
      // into the versioned public payload unannounced.
      const base = { userId, leaveTypeId: t.id, year, tracked: b.tracked, used: b.used, pending: b.pending };
      if (!b.tracked) return [{ ...base, allowance: null, carriedOver: null, adjustment: null, total: null, carriedOut: null, remaining: null }];
      return [{ ...base, allowance: b.allowance, carriedOver: b.carriedOver, adjustment: b.adjustment, total: b.total, carriedOut: b.carriedOut, remaining: b.remaining }];
    }),
  );
  return { year, data };
}

/** The company's holidays in one year (default: the current year in its time zone), by date. Two queries. */
export async function listHolidaysForApi(ctx: ServiceContext, client: ApiClient, q: { year?: number }) {
  assertScope(client, "read");
  const { year } = await companyYear(ctx, client, q.year);
  const rows = await listHolidayRows(ctx.db, client.companyId, `${year}-01-01`, `${year}-12-31`);
  return { year, data: rows.map((h) => ({ id: h.id, date: h.date, name: h.name })) };
}

/**
 * The company's events after event `after` (from the oldest kept without it), in the
 * order a poller can rely on: an event never appears behind one already returned (see
 * `listCompanyEvents`). Pass the last `id` you processed as `after`. Two queries with a
 * cursor (it must be an event of the company), one without.
 *
 * @throws DomainError `invalid_input` when `after` is not an event of the company (or
 *   was pruned by retention; start again without it).
 */
export async function listEventsForApi(
  ctx: ServiceContext,
  client: ApiClient,
  q: { after?: string; limit: number },
): Promise<{ data: EventEnvelope[]; hasMore: boolean }> {
  assertScope(client, "read");
  if (q.after !== undefined && (!isUuid(q.after) || !(await companyEventExists(ctx.db, client.companyId, q.after)))) {
    throw new DomainError("invalid_input", "`after` is not an event of this company.");
  }
  const rows = await listCompanyEvents(ctx.db, { companyId: client.companyId, afterId: q.after, limit: q.limit + 1 });
  const more = rows.length > q.limit;
  return { data: (more ? rows.slice(0, q.limit) : rows).map(buildEnvelope), hasMore: more };
}
