/**
 * The read-only audit log viewer: who changed what, and when, newest first.
 */
import type { Actor } from "@/domain/actor";
import { assertCanAdminister } from "@/domain/admin-permissions";
import { AUDIT_ACTION_LABELS, auditActionLabel, describeAuditChange, isAuditAction } from "@/domain/audit";
import { isCalendarDate } from "@/domain/calendar-date";
import { type ChangeSourceKind, changeSourceLabel, recordedChangeSource } from "@/domain/change-source";
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
  /** Who or what did it: "Ana", "Ana, via Gusto sync", "System: year rollover" (`changeSourceLabel`). */
  actorLabel: string;
  /** Whether a person (directly, through something, or with an API key) or a system process did it. */
  actorKind: ChangeSourceKind;
  /** Who it is about, if anyone. */
  subjectName: string | null;
  /** What changed, one line per field. */
  changes: string[];
}

type AuditRow = Awaited<ReturnType<typeof listAuditPage>>[number];
type AuditNames = Parameters<typeof describeAuditChange>[2];

/**
 * What naming audit rows takes, loaded once per read in parallel: the company (its time
 * zone), its people (deleted ones included, so history still names them), departments
 * and leave types (for ids inside before/after snapshots).
 *
 * @throws DomainError `no_company`.
 */
async function loadAuditNaming(ctx: ServiceContext, companyId: string) {
  const [company, people, departments, leaveTypes] = await Promise.all([
    findCompany(ctx.db, companyId),
    listPeopleNames(ctx.db, companyId, { includeDeleted: true }),
    listDepartments(ctx.db, companyId),
    listAllLeaveTypes(ctx.db, companyId),
  ]);
  if (!company) throw new DomainError("no_company");
  const peopleById = new Map(people.map((p) => [p.id, personLabel(p)]));
  const departmentsById = new Map(departments.map((d) => [d.id, d.name]));
  const typesById = new Map(leaveTypes.map((t) => [t.id, t.name]));
  const names: AuditNames = {
    person: (id: string) => peopleById.get(id),
    department: (id: string) => departmentsById.get(id),
    leaveType: (id: string) => typesById.get(id),
  };
  return { company, people, names };
}

function toAuditEntry(ctx: ServiceContext, r: AuditRow, names: AuditNames): AuditLogEntry {
  return {
    id: r.id,
    at: r.createdAt,
    action: r.action,
    label: auditActionLabel(r.action),
    actorLabel: changeSourceLabel(recordedChangeSource(r), {
      person: (id) => {
        if (id === r.actorId && r.actorName !== null) return personLabel({ name: r.actorName, email: r.actorEmail ?? "" });
        if (id === r.actorRequestedBy && r.requesterName !== null) return personLabel({ name: r.requesterName, email: r.requesterEmail ?? "" });
        return undefined;
      },
      apiKey: () => (r.apiKeyName === null ? undefined : { name: r.apiKeyName, prefix: r.apiKeyPrefix ?? "" }),
      adapter: (id) => ctx.adapters.get(id)?.displayName,
    }),
    actorKind: r.actorKind === "user" || r.actorKind === "api_key" ? r.actorKind : "system",
    subjectName: r.subjectUserId ? personLabel({ name: r.subjectName ?? "", email: r.subjectEmail ?? "" }) || null : null,
    changes: describeAuditChange(r.before, r.after, names),
  };
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
  const { company, people, names } = await loadAuditNaming(ctx, actor.companyId);

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

  const page = rows.slice(0, AUDIT_PAGE_SIZE);
  const last = page.at(-1);
  return {
    timezone: company.timezone,
    entries: page.map((r) => toAuditEntry(ctx, r, names)),
    nextCursor: rows.length > AUDIT_PAGE_SIZE && last ? encodeCursor({ createdAt: last.cursor, id: last.id }) : null,
    filters: {
      action,
      actorId: personId(filter.actorId),
      subjectUserId: personId(filter.subjectUserId),
      from,
      to,
    },
    // Pickers never offer deleted people; their rows still name them (above).
    people: people.filter((p) => !p.deleted).map((p) => ({ id: p.id, label: personLabel(p) })),
    actions: Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => ({ value, label })),
  };
}

/** Rows read per query by {@link listAuditEntriesAbout}. */
const ABOUT_BATCH = 1_000;

/**
 * Every audit entry about one person (`subject_user_id`), newest first, at most `max`:
 * for their records export. The names load once, then the rows come a thousand at a
 * time, so a long history costs a handful of queries.
 *
 * @throws DomainError `forbidden` for a non-admin, `no_company`.
 */
export async function listAuditEntriesAbout(ctx: ServiceContext, actor: Actor, subjectUserId: string, max: number): Promise<AuditLogEntry[]> {
  assertCanAdminister(actor);
  const { company, names } = await loadAuditNaming(ctx, actor.companyId);
  const entries: AuditLogEntry[] = [];
  let after: AuditCursor | undefined;
  while (entries.length < max) {
    const limit = Math.min(ABOUT_BATCH, max - entries.length);
    const rows = await listAuditPage(ctx.db, { companyId: actor.companyId, subjectUserId, timezone: company.timezone, after }, limit);
    entries.push(...rows.map((r) => toAuditEntry(ctx, r, names)));
    const last = rows.at(-1);
    if (rows.length < limit || !last) break;
    after = { createdAt: last.cursor, id: last.id };
  }
  return entries;
}
