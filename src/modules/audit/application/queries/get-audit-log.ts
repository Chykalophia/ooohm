import "server-only";
import type { Actor } from "@/domain/actor";
import { AUDIT_ACTION_LABELS, isAuditAction } from "@/domain/audit";
import { isCalendarDate } from "@/domain/calendar-date";
import { readPage } from "@/domain/paging";
import { personLabel } from "@/shared/kernel/person-label";
import type { ServiceContext } from "@/server/context";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { listAuditPage } from "@/modules/audit/infrastructure/drizzle-audit-log.repository";
import { AUDIT_KEY, loadAuditNaming, pageSize, personId, searchFor } from "@/modules/audit/application/audit-reading";
import { type AuditLogDTO, toAuditLogEntryDTO } from "@/modules/audit/application/dto";
import { canViewAuditLog } from "@/modules/audit/application/policies";
import type { AuditLogFilter } from "@/modules/audit/application/schemas";

/**
 * One page of the company's audit log, newest first, with the names the filters and
 * summaries need.
 *
 * A fixed six queries whatever the page holds: the company's time zone, its people,
 * departments, levels and leave types in parallel (for the filter pickers and for naming ids
 * inside before/after snapshots), then the page itself, whose actor and subject names
 * come from joins.
 *
 * Fails with `forbidden` for a non-admin, `no_company`.
 */
export async function getAuditLog(ctx: ServiceContext, actor: Actor, filter: AuditLogFilter): Promise<ServiceResult<AuditLogDTO>> {
  if (!canViewAuditLog(actor)) return err("forbidden");
  return attempt(() => readAuditLog(ctx, actor, filter));
}

async function readAuditLog(ctx: ServiceContext, actor: Actor, filter: AuditLogFilter): Promise<AuditLogDTO> {
  const action = filter.action && isAuditAction(filter.action) ? filter.action : undefined;
  const from = filter.from && isCalendarDate(filter.from) ? filter.from : undefined;
  const to = filter.to && isCalendarDate(filter.to) ? filter.to : undefined;
  const { company, people, names } = await loadAuditNaming(ctx, actor.companyId);

  const search = searchFor(filter.query, people);
  const query = {
    companyId: actor.companyId,
    search: search?.matches,
    action,
    actorId: personId(filter.actorId),
    subjectUserId: personId(filter.subjectUserId),
    from,
    to,
    timezone: company.timezone,
    oldestFirst: filter.oldestFirst === true,
  };
  const size = pageSize(filter.size);
  const page = await readPage({
    cursor: filter.page,
    size,
    checks: AUDIT_KEY,
    read: (request, limit) => listAuditPage(ctx.db, { ...query, page: request }, limit),
    keyOf: (r) => [r.cursor, r.id],
  });

  return {
    timezone: company.timezone,
    entries: page.items.map((r) => toAuditLogEntryDTO(r, names)),
    previous: page.previous,
    next: page.next,
    oldestFirst: query.oldestFirst,
    size,
    filters: {
      query: search?.text,
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
