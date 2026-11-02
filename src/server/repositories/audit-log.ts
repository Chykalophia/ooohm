import { and, count, desc, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { apiKeys, auditLog, user } from "@/db/schema";
import type { Executor } from "@/db/types";

/** Where a page of the audit log starts: just older than this row. */
export interface AuditCursor {
  /** `created_at` in UTC to the microsecond, as `YYYY-MM-DDTHH:MM:SS.ffffffZ`. */
  createdAt: string;
  id: string;
}

/** Which audit rows to read; every filter is optional except the company. */
export interface AuditQuery {
  companyId: string;
  action?: string;
  actorId?: string;
  subjectUserId?: string;
  /** First day to include, in `timezone`. */
  from?: string;
  /** Last day to include, in `timezone`. */
  to?: string;
  timezone: string;
  /** Read rows older than this one (keyset pagination); newest first when absent. */
  after?: AuditCursor;
}

const actor = alias(user, "actor");
const subject = alias(user, "subject");

/**
 * One page of the company's audit log, newest first, keyset-paginated on
 * `(created_at, id)`. One query whatever the page size: the actor's and subject's names,
 * and the API key's name and prefix, come from joins. With at most one of action, actor or person set, the scan runs on the
 * matching `audit_log_company_*_idx` index in order, so it reads about `limit` rows.
 *
 * Each row carries its own cursor, `created_at` printed in UTC to the microsecond: a JS
 * `Date` keeps only milliseconds, which would skip or repeat rows written in the same one.
 */
export async function listAuditPage(ex: Executor, q: AuditQuery, limit: number) {
  const dayStart = (date: string) => sql`(${date}::date::timestamp at time zone ${q.timezone})`;
  return ex
    .select({
      id: auditLog.id,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      before: auditLog.before,
      after: auditLog.after,
      createdAt: auditLog.createdAt,
      cursor: sql<string>`to_char(${auditLog.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      actorKind: auditLog.actorKind,
      actorId: auditLog.actorId,
      actorName: actor.name,
      actorEmail: actor.email,
      apiKeyId: auditLog.apiKeyId,
      apiKeyName: apiKeys.name,
      apiKeyPrefix: apiKeys.prefix,
      actorVia: auditLog.actorVia,
      actorProcess: auditLog.actorProcess,
      subjectUserId: auditLog.subjectUserId,
      subjectName: subject.name,
      subjectEmail: subject.email,
    })
    .from(auditLog)
    .leftJoin(actor, eq(actor.id, auditLog.actorId))
    .leftJoin(apiKeys, eq(apiKeys.id, auditLog.apiKeyId))
    .leftJoin(subject, eq(subject.id, auditLog.subjectUserId))
    .where(
      and(
        eq(auditLog.companyId, q.companyId),
        q.action ? eq(auditLog.action, q.action) : undefined,
        q.actorId ? eq(auditLog.actorId, q.actorId) : undefined,
        q.subjectUserId ? eq(auditLog.subjectUserId, q.subjectUserId) : undefined,
        q.from ? gte(auditLog.createdAt, dayStart(q.from)) : undefined,
        q.to ? lt(auditLog.createdAt, sql`(${q.to}::date + 1)::timestamp at time zone ${q.timezone}`) : undefined,
        q.after
          ? sql`(${auditLog.createdAt}, ${auditLog.id}) < (${q.after.createdAt}::timestamptz, ${q.after.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit);
}

/**
 * How many audit rows with one of `actions` the actor wrote in the company in the last
 * `minutes`, on the database clock that stamps them. Served by `audit_log_company_actor_idx`.
 */
export async function countRecentActions(
  ex: Executor,
  where: { companyId: string; actorId: string; actions: readonly string[] },
  minutes: number,
): Promise<number> {
  const [row] = await ex
    .select({ n: count() })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.companyId, where.companyId),
        eq(auditLog.actorId, where.actorId),
        inArray(auditLog.action, [...where.actions]),
        gt(auditLog.createdAt, sql`now() - make_interval(mins => ${minutes})`),
      ),
    );
  return row?.n ?? 0;
}
