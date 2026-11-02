/**
 * The read-only audit log viewer: who changed what, and when, newest first.
 */
import type { Actor } from "@/domain/actor";
import { assertCanAdminister } from "@/domain/admin-permissions";
import { AUDIT_ACTION_LABELS, auditActionLabel, describeAuditChange, isAuditAction } from "@/domain/audit";
import { isCalendarDate } from "@/domain/calendar-date";
import { DomainError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { personLabel } from "@/domain/person";
import type { ServiceContext } from "@/server/context";
import { type AuditCursor, listAuditPage } from "@/server/repositories/audit-log";
import { listDepartments } from "@/server/repositories/departments";
import { findCompany } from "@/server/repositories/companies";
import { listAllLeaveTypes } from "@/server/repositories/leave-types";
import { listPeopleNames } from "@/server/repositories/users";

/** Rows per page. */
export const AUDIT_PAGE_SIZE = 50;

/** What the viewer filters on. Anything malformed is ignored rather than refused. */
export interface AuditLogFilter {
  action?: string;
  actorId?: string;
  subjectUserId?: string;
  /** First day, `YYYY-MM-DD`, in the company's time zone. */
  from?: string;
  /** Last day, `YYYY-MM-DD`, in the company's time zone. */
  to?: string;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string;
}

const CURSOR = /^((\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z)_([0-9a-f-]{36})$/;

function encodeCursor(c: AuditCursor): string {
  return `${c.createdAt}_${c.id}`;
}

/**
 * The cursor in `value`, or `undefined` (first page) when it is not one this service
 * made. The timestamp must be a real instant, not just the right shape: Postgres
 * refuses `2026-99-99T99:99:99` outright, which would turn a forged link into an error page.
 */
export function decodeAuditCursor(value: string | undefined): AuditCursor | undefined {
  const m = value ? CURSOR.exec(value) : null;
  if (!m || !isUuid(m[6]) || !isCalendarDate(m[2])) return undefined;
  const [hh, mm, ss] = [Number(m[3]), Number(m[4]), Number(m[5])];
  if (hh > 23 || mm > 59 || ss > 59) return undefined;
  return { createdAt: m[1], id: m[6] };
}

const personId = (v: string | undefined) => (v && v.length <= 100 ? v : undefined);

/** One row as the viewer shows it. */
export interface AuditLogEntry {
  id: string;
  at: Date;
  action: string;
  label: string;
  /** Who did it; "OOOhm" for a system job such as the year rollover. */
  actorName: string;
  /** Who it is about, if anyone. */
  subjectName: string | null;
  /** What changed, one line per field. */
  changes: string[];
}

/**
 * One page of the company's audit log, newest first, with the names the filters and
 * summaries need.
 *
 * A fixed five queries whatever the page holds: the company's time zone, its people,
 * departments and leave types in parallel (for the filter pickers and for naming ids
 * inside before/after snapshots), then the page itself, whose actor and subject names
 * come from joins.
 *
 * @throws DomainError `forbidden` for a non-admin, `no_company`.
 */
export async function getAuditLog(ctx: ServiceContext, actor: Actor, filter: AuditLogFilter) {
  assertCanAdminister(actor);
  const action = filter.action && isAuditAction(filter.action) ? filter.action : undefined;
  const from = filter.from && isCalendarDate(filter.from) ? filter.from : undefined;
  const to = filter.to && isCalendarDate(filter.to) ? filter.to : undefined;
  const [company, people, departments, leaveTypes] = await Promise.all([
    findCompany(ctx.db, actor.companyId),
    listPeopleNames(ctx.db, actor.companyId),
    listDepartments(ctx.db, actor.companyId),
    listAllLeaveTypes(ctx.db, actor.companyId),
  ]);
  if (!company) throw new DomainError("no_company");

  const rows = await listAuditPage(
    ctx.db,
    {
      companyId: actor.companyId,
      action,
      actorId: personId(filter.actorId),
      subjectUserId: personId(filter.subjectUserId),
      from,
      to,
      timezone: company.timezone,
      after: decodeAuditCursor(filter.cursor),
    },
    AUDIT_PAGE_SIZE + 1,
  );

  const peopleById = new Map(people.map((p) => [p.id, personLabel(p)]));
  const departmentsById = new Map(departments.map((d) => [d.id, d.name]));
  const typesById = new Map(leaveTypes.map((t) => [t.id, t.name]));
  const names = {
    person: (id: string) => peopleById.get(id),
    department: (id: string) => departmentsById.get(id),
    leaveType: (id: string) => typesById.get(id),
  };

  const page = rows.slice(0, AUDIT_PAGE_SIZE);
  const last = page.at(-1);
  return {
    timezone: company.timezone,
    entries: page.map(
      (r): AuditLogEntry => ({
        id: r.id,
        at: r.createdAt,
        action: r.action,
        label: auditActionLabel(r.action),
        actorName: r.actorId ? personLabel({ name: r.actorName ?? "", email: r.actorEmail ?? "" }) || "Someone" : "OOOhm",
        subjectName: r.subjectUserId ? personLabel({ name: r.subjectName ?? "", email: r.subjectEmail ?? "" }) || null : null,
        changes: describeAuditChange(r.before, r.after, names),
      }),
    ),
    nextCursor: rows.length > AUDIT_PAGE_SIZE && last ? encodeCursor({ createdAt: last.cursor, id: last.id }) : null,
    filters: {
      action,
      actorId: personId(filter.actorId),
      subjectUserId: personId(filter.subjectUserId),
      from,
      to,
    },
    people: people.map((p) => ({ id: p.id, label: personLabel(p) })),
    actions: Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => ({ value, label })),
  };
}
