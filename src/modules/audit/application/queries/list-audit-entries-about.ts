import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { DomainError } from "@/shared/kernel/errors";
import type { PageRequest } from "@/shared/kernel/paging";
import type { ServiceContext } from "@/server/context";
import { listAuditPage } from "@/modules/audit/infrastructure/drizzle-audit-log.repository";
import { loadAuditNaming } from "@/modules/audit/application/audit-reading";
import { type AuditLogEntryDTO, toAuditLogEntryDTO } from "@/modules/audit/application/dto";
import { canViewAuditLog } from "@/modules/audit/application/policies";

/** Rows read per query by {@link listAuditEntriesAbout}. */
const ABOUT_BATCH = 1_000;

/**
 * Every audit entry about one person (`subject_user_id`), newest first, at most `max`:
 * for their records export, which runs inside the people module's own flow and so gets
 * plain values. The names load once, then the rows come a thousand at a time, so a long
 * history costs a handful of queries.
 *
 * @throws DomainError `forbidden` for a non-admin, `no_company`.
 */
export async function listAuditEntriesAbout(ctx: ServiceContext, actor: Actor, subjectUserId: string, max: number): Promise<AuditLogEntryDTO[]> {
  if (!canViewAuditLog(actor)) throw new DomainError("forbidden");
  const { company, names } = await loadAuditNaming(ctx, actor.companyId);
  const entries: AuditLogEntryDTO[] = [];
  let page: PageRequest | undefined;
  while (entries.length < max) {
    const limit = Math.min(ABOUT_BATCH, max - entries.length);
    const rows = await listAuditPage(ctx.db, { companyId: actor.companyId, subjectUserId, timezone: company.timezone, page }, limit);
    entries.push(...rows.map((r) => toAuditLogEntryDTO(r, names)));
    const last = rows.at(-1);
    if (rows.length < limit || !last) break;
    page = { direction: "after", key: [last.cursor, last.id] };
  }
  return entries;
}
