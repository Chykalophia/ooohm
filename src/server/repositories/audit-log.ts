import { and, count, eq, gt, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { apiKeys, auditLog, user } from "@/db/schema";
import type { Executor } from "@/db/types";
import type { PageRequest } from "@/domain/paging";
import { cursorInstant, keysetPage } from "./keyset";

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
  /** Oldest first instead of newest first. */
  oldestFirst?: boolean;
  /**
   * A search, resolved by the service into what each word matched: a row matches a word
   * when its action is one of the word's `actions`, or it was done by or is about one of
   * its `people`; it must match every word. A word that matched nothing means no rows.
   */
  search?: readonly { actions: readonly string[]; people: readonly string[] }[];
  /** The page: after or before a `[created_at, id]` key (`created_at` as {@link cursorInstant} prints it); the first page (the newest, or the oldest with `oldestFirst`) when absent. */
  page?: PageRequest;
}

/** A row matching one resolved search word: by its action, its actor or its subject. Each arm can use its own index. */
function wordMatches({ actions, people }: { actions: readonly string[]; people: readonly string[] }) {
  const arms = [
    actions.length > 0 ? inArray(auditLog.action, [...actions]) : undefined,
    people.length > 0 ? inArray(auditLog.actorId, [...people]) : undefined,
    people.length > 0 ? inArray(auditLog.subjectUserId, [...people]) : undefined,
  ].filter((arm) => arm !== undefined);
  return arms.length > 0 ? or(...arms) : sql`false`;
}

const actor = alias(user, "actor");
const subject = alias(user, "subject");
const requester = alias(user, "requester");

/**
 * One page of the company's audit log, newest first (or oldest), keyset-paginated on
 * `(created_at, id)`. One query whatever the page size: the actor's, subject's and (for a
 * scheduled run) requester's names, and the API key's name and prefix, come from joins. With at most one of action, actor or person set, the scan runs on the
 * matching `audit_log_company_*_idx` index in order, so it reads about `limit` rows.
 *
 * Each row carries its own cursor, `created_at` printed in UTC to the microsecond: a JS
 * `Date` keeps only milliseconds, which would skip or repeat rows written in the same one.
  *
 * A search is not read in index order: its rows match one of several ids on any of three
 * columns, so Postgres reads every match and sorts them (or walks the company index and
 * filters). Fine at a small company's size; `tests/e2e/explain-queries.mts` shows the plan.
 */
export async function listAuditPage(ex: Executor, q: AuditQuery, limit: number) {
  const dayStart = (date: string) => sql`(${date}::date::timestamp at time zone ${q.timezone})`;
  const page = keysetPage(q.oldestFirst ? "asc" : "desc", [auditLog.createdAt, auditLog.id], q.page, ([at, id]) => [sql`${at}::timestamptz`, sql`${id}::uuid`]);
  return ex
    .select({
      id: auditLog.id,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      before: auditLog.before,
      after: auditLog.after,
      createdAt: auditLog.createdAt,
      cursor: cursorInstant(auditLog.createdAt),
      actorKind: auditLog.actorKind,
      actorId: auditLog.actorId,
      actorName: actor.name,
      actorEmail: actor.email,
      apiKeyId: auditLog.apiKeyId,
      apiKeyName: apiKeys.name,
      apiKeyPrefix: apiKeys.prefix,
      actorVia: auditLog.actorVia,
      actorProcess: auditLog.actorProcess,
      actorRequestedBy: auditLog.actorRequestedBy,
      requesterName: requester.name,
      requesterEmail: requester.email,
      subjectUserId: auditLog.subjectUserId,
      subjectName: subject.name,
      subjectEmail: subject.email,
    })
    .from(auditLog)
    .leftJoin(actor, eq(actor.id, auditLog.actorId))
    .leftJoin(apiKeys, eq(apiKeys.id, auditLog.apiKeyId))
    .leftJoin(subject, eq(subject.id, auditLog.subjectUserId))
    .leftJoin(requester, eq(requester.id, auditLog.actorRequestedBy))
    .where(
      and(
        eq(auditLog.companyId, q.companyId),
        q.action ? eq(auditLog.action, q.action) : undefined,
        q.actorId ? eq(auditLog.actorId, q.actorId) : undefined,
        q.subjectUserId ? eq(auditLog.subjectUserId, q.subjectUserId) : undefined,
        ...(q.search ?? []).map(wordMatches),
        q.from ? gte(auditLog.createdAt, dayStart(q.from)) : undefined,
        q.to ? lt(auditLog.createdAt, sql`(${q.to}::date + 1)::timestamp at time zone ${q.timezone}`) : undefined,
        page.where,
      ),
    )
    .orderBy(...page.orderBy)
    .limit(limit);
}

/**
 * How many audit rows with one of `actions` the actor wrote in the company in the last
 * `minutes`, on the database clock that stamps them. Served by `audit_log_company_actor_idx`.
 *
 * @param where.via Only rows made through this process; `null` for rows made directly
 *   (no `via`). Absent counts both.
 */
export async function countRecentActions(
  ex: Executor,
  where: { companyId: string; actorId: string; actions: readonly string[]; via?: string | null },
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
        where.via === undefined ? undefined : where.via === null ? isNull(auditLog.actorVia) : eq(auditLog.actorVia, where.via),
        gt(auditLog.createdAt, sql`now() - make_interval(mins => ${minutes})`),
      ),
    );
  return row?.n ?? 0;
}
