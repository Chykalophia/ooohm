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
import { type PageCursor, type PageRequest, isCursorInstant, readPage } from "@/domain/paging";
import { personLabel } from "@/domain/person";
import type { ServiceContext } from "@/server/context";
import { listAuditPage } from "@/server/repositories/audit-log";
import { listDepartments } from "@/server/repositories/departments";
import { findCompany } from "@/server/repositories/companies";
import { listAllLeaveTypes } from "@/server/repositories/leave-types";
import { listPeopleNames } from "@/server/repositories/users";

/** Entries per page: a screen or two of the log, so it stays easy to scan. */
export const AUDIT_PAGE_SIZE = 25;

/** What the viewer filters on. Anything malformed is ignored rather than refused. */
export interface AuditLogFilter {
  action?: string;
  actorId?: string;
  subjectUserId?: string;
  /** First day, `YYYY-MM-DD`, in the company's time zone. */
  from?: string;
  /** Last day, `YYYY-MM-DD`, in the company's time zone. */
  to?: string;
  /** The page, from a previous page's `previous` or `next`; the newest entries when absent. */
  page?: PageCursor;
}

/** An audit page's key: `[created_at, id]`. */
const AUDIT_KEY = [isCursorInstant, isUuid] as const;

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

  const query = {
    companyId: actor.companyId,
    action,
    actorId: personId(filter.actorId),
    subjectUserId: personId(filter.subjectUserId),
    from,
    to,
    timezone: company.timezone,
  };
  const page = await readPage({
    cursor: filter.page,
    size: AUDIT_PAGE_SIZE,
    checks: AUDIT_KEY,
    read: (request, limit) => listAuditPage(ctx.db, { ...query, page: request }, limit),
    keyOf: (r) => [r.cursor, r.id],
  });

  return {
    timezone: company.timezone,
    entries: page.items.map((r) => toAuditEntry(ctx, r, names)),
    previous: page.previous,
    next: page.next,
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
  let page: PageRequest | undefined;
  while (entries.length < max) {
    const limit = Math.min(ABOUT_BATCH, max - entries.length);
    const rows = await listAuditPage(ctx.db, { companyId: actor.companyId, subjectUserId, timezone: company.timezone, page }, limit);
    entries.push(...rows.map((r) => toAuditEntry(ctx, r, names)));
    const last = rows.at(-1);
    if (rows.length < limit || !last) break;
    page = { direction: "after", key: [last.cursor, last.id] };
  }
  return entries;
}
