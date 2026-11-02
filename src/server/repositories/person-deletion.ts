/**
 * Queries behind deleting a person: the facts the rules and the confirmation need, the
 * deletes and the tombstone write, the lookups of stored text that mentions them, and
 * the scheduled-scrub bookkeeping. No rules here: the deletion service decides what runs.
 *
 * Mentions are found by substring (`strpos` on the lowercased text, so `%` and `_` in an
 * address match only themselves) and then redacted precisely by the service. The mention
 * scans (outbox, deliveries, adapter errors, import runs, audit snapshots, leave notes,
 * the labels of company settings) read every row of the company's table: they run once
 * per delete, a rare admin action over a small team's history, so they do without
 * indexes of their own. Everything else here goes through an index on the person.
 */
import { and, asc, count, eq, inArray, isNotNull, isNull, lte, ne, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  account,
  adapterDeliveries,
  allowances,
  apiKeys,
  auditLog,
  calendarFeedTokens,
  departments,
  eventsOutbox,
  holidays,
  importRuns,
  leaveRequestDays,
  leaveRequests,
  leaveTypes,
  session,
  user,
  verification,
  webhookDeliveries,
  webhookEndpoints,
} from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";
import type { DeletionCounts, DeletionMode } from "@/domain/person-deletion";

/** True when `column`'s text contains any of `needles` (already lowercased). */
function mentions(column: SQL, needles: readonly string[]): SQL {
  if (needles.length === 0) return sql`false`;
  return or(...needles.map((n) => sql`strpos(lower(${column}), ${n}) > 0`))!;
}

/** The people who report to `userId`: their manager has to change before a delete. */
export async function listReportsOf(ex: Executor, companyId: string, userId: string) {
  return ex
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(and(eq(user.companyId, companyId), eq(user.managerId, userId), isNull(user.deletedAt)))
    .orderBy(asc(sql`lower(${user.name})`), asc(user.email));
}

/**
 * The names of the company's other people that are still in use: everyone not deleted,
 * and those deleted with their records kept (their history still names them).
 */
export async function listOtherNames(ex: Executor, companyId: string, userId: string) {
  return ex
    .select({ name: user.name, deletionMode: user.deletionMode })
    .from(user)
    .where(and(eq(user.companyId, companyId), ne(user.id, userId), or(isNull(user.deletedAt), eq(user.deletionMode, "records_kept"))));
}

/**
 * Withdraws the person's own pending requests (status `cancelled`), so nobody is left to
 * decide leave for someone who is gone. @returns How many.
 */
export async function withdrawPendingRequestsOf(tx: Transaction, companyId: string, userId: string, at: Date): Promise<number> {
  const rows = await tx
    .update(leaveRequests)
    .set({ status: "cancelled", updatedAt: at })
    .where(and(eq(leaveRequests.companyId, companyId), eq(leaveRequests.userId, userId), eq(leaveRequests.status, "pending")))
    .returning({ id: leaveRequests.id });
  return rows.length;
}

/** Pending requests of the company assigned to `userId` to decide. */
export async function countPendingAssignedTo(ex: Executor, companyId: string, userId: string): Promise<number> {
  const [row] = await ex
    .select({ n: count() })
    .from(leaveRequests)
    .where(and(eq(leaveRequests.companyId, companyId), eq(leaveRequests.approverId, userId), eq(leaveRequests.status, "pending")));
  return row?.n ?? 0;
}

/** What a delete of `userId` would remove, counted in one statement. */
export async function countDeletionFacts(ex: Executor, companyId: string, userId: string): Promise<DeletionCounts> {
  const n = (q: SQL) => sql<number>`(${q})::int`;
  const [row] = await ex
    .select({
      leaveRequests: n(sql`select count(*) from ${leaveRequests} where ${leaveRequests.companyId} = ${companyId} and ${leaveRequests.userId} = ${userId}`),
      pendingRequests: n(
        sql`select count(*) from ${leaveRequests} where ${leaveRequests.companyId} = ${companyId} and ${leaveRequests.userId} = ${userId} and ${leaveRequests.status} = 'pending'`,
      ),
      balanceYears: n(sql`select count(distinct ${allowances.year}) from ${allowances} where ${allowances.userId} = ${userId}`),
      allowanceRows: n(sql`select count(*) from ${allowances} where ${allowances.userId} = ${userId}`),
      auditEntries: n(sql`select count(*) from ${auditLog} where ${auditLog.companyId} = ${companyId} and ${auditLog.subjectUserId} = ${userId}`),
      sessions: n(sql`select count(*) from ${session} where ${session.userId} = ${userId}`),
      accounts: n(sql`select count(*) from ${account} where ${account.userId} = ${userId}`),
      calendarFeeds: n(sql`select count(*) from ${calendarFeedTokens} where ${calendarFeedTokens.userId} = ${userId}`),
    })
    .from(sql`(select 1) as one`);
  return {
    leaveRequests: Number(row.leaveRequests),
    pendingRequests: Number(row.pendingRequests),
    balanceYears: Number(row.balanceYears),
    allowanceRows: Number(row.allowanceRows),
    auditEntries: Number(row.auditEntries),
    sessions: Number(row.sessions),
    accounts: Number(row.accounts),
    calendarFeeds: Number(row.calendarFeeds),
  };
}

/**
 * Removes everything that lets the person sign in or be reached: every session, every
 * linked account (Google), every unused sign-in link sent to their address, and every
 * calendar feed link, live or revoked.
 */
export async function deleteSignInOf(tx: Transaction, person: { id: string; email: string }) {
  const sessions = await tx.delete(session).where(eq(session.userId, person.id)).returning({ id: session.id });
  const accounts = await tx.delete(account).where(eq(account.userId, person.id)).returning({ id: account.id });
  // A magic link stores `{"type":"magic-link","email":"<address>",...}` under a random
  // identifier; other flows key verification rows by the address itself.
  const emailField = `"email":${JSON.stringify(person.email.toLowerCase())}`;
  const verifications = await tx
    .delete(verification)
    .where(or(sql`strpos(lower(${verification.value}), ${emailField}) > 0`, sql`lower(${verification.identifier}) = ${person.email.toLowerCase()}`))
    .returning({ id: verification.id });
  const feeds = await tx.delete(calendarFeedTokens).where(eq(calendarFeedTokens.userId, person.id)).returning({ id: calendarFeedTokens.id });
  return { sessions: sessions.length, accounts: accounts.length, verifications: verifications.length, calendarFeeds: feeds.length };
}

/** Clears the manager of anyone in the company who still reports to `userId`. @returns How many. */
export async function clearManagerOf(tx: Transaction, companyId: string, userId: string): Promise<number> {
  const rows = await tx
    .update(user)
    .set({ managerId: null })
    .where(and(eq(user.companyId, companyId), eq(user.managerId, userId)))
    .returning({ id: user.id });
  return rows.length;
}

/** Deletes the person's own leave requests (their per-year days go with them). @returns How many. */
export async function deleteLeaveRequestsOf(tx: Transaction, companyId: string, userId: string): Promise<number> {
  const rows = await tx
    .delete(leaveRequests)
    .where(and(eq(leaveRequests.companyId, companyId), eq(leaveRequests.userId, userId)))
    .returning({ id: leaveRequests.id });
  return rows.length;
}

/** Deletes the person's allowance rows, every year. @returns How many. */
export async function deleteAllowancesOf(tx: Transaction, userId: string): Promise<number> {
  const rows = await tx.delete(allowances).where(eq(allowances.userId, userId)).returning({ id: allowances.id });
  return rows.length;
}

/**
 * Deletes the audit rows about the person: every row whose subject they are, and every
 * row whose entity is their account. Rows where they acted on someone else stay (those
 * belong to the other person). @returns How many.
 */
export async function deleteAuditAbout(tx: Transaction, companyId: string, userId: string): Promise<number> {
  // The company filter lets each arm use an index (company and subject; entity), so the
  // log, which has no retention, is never read whole.
  const rows = await tx
    .delete(auditLog)
    .where(
      and(
        eq(auditLog.companyId, companyId),
        or(eq(auditLog.subjectUserId, userId), and(eq(auditLog.entityType, "user"), eq(auditLog.entityId, userId))),
      ),
    )
    .returning({ id: auditLog.id });
  return rows.length;
}

/**
 * What the person's own records say their name was: the payloads of their events that
 * carry a name, and the before and after snapshots of the audit rows about their account.
 * Read before a scrub removes those rows, to learn names they had before a rename.
 */
export async function listOwnNameRecords(ex: Executor, companyId: string, userId: string): Promise<{ events: unknown[]; accountSnapshots: unknown[] }> {
  const [events, audit] = await Promise.all([
    ex
      .select({ payload: eventsOutbox.payload })
      .from(eventsOutbox)
      .where(
        and(
          eq(eventsOutbox.companyId, companyId),
          sql`${eventsOutbox.payload}->>'userId' = ${userId}`,
          sql`${eventsOutbox.payload}->>'name' is not null`,
        ),
      ),
    ex
      .select({ before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.companyId, companyId), eq(auditLog.entityType, "user"), eq(auditLog.entityId, userId))),
  ]);
  return { events: events.map((e) => e.payload), accountSnapshots: audit.flatMap((a) => [a.before, a.after]) };
}

/** Turns the person's row into a tombstone: new name and email, no sign-in identity, out of every team. */
export async function writeTombstone(
  tx: Transaction,
  companyId: string,
  userId: string,
  values: { name: string; email: string; mode: DeletionMode; at: Date },
): Promise<void> {
  await tx
    .update(user)
    .set({
      name: values.name,
      email: values.email,
      emailVerified: false,
      image: null,
      isActive: false,
      role: "employee",
      canSelfApprove: false,
      managerId: null,
      departmentId: null,
      deletedAt: values.at,
      deletionMode: values.mode,
      scrubScheduledAt: null,
      scrubRequestedBy: null,
    })
    .where(and(eq(user.id, userId), eq(user.companyId, companyId)));
}

/** The company's outbox events whose payload mentions any of `needles`. */
export async function listEventsMentioning(ex: Executor, companyId: string, needles: readonly string[]) {
  return ex
    .select({ id: eventsOutbox.id, payload: eventsOutbox.payload })
    .from(eventsOutbox)
    .where(and(eq(eventsOutbox.companyId, companyId), mentions(sql`${eventsOutbox.payload}::text`, needles)));
}

export async function setEventPayload(tx: Transaction, id: string, payload: unknown): Promise<void> {
  await tx.update(eventsOutbox).set({ payload }).where(eq(eventsOutbox.id, id));
}

/** The company's webhook deliveries whose stored body or response excerpt mentions any of `needles`. */
export async function listDeliveriesMentioning(ex: Executor, companyId: string, needles: readonly string[]) {
  return ex
    .select({
      id: webhookDeliveries.id,
      status: webhookDeliveries.status,
      body: webhookDeliveries.body,
      lastResponseExcerpt: webhookDeliveries.lastResponseExcerpt,
    })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.companyId, companyId),
        or(mentions(sql`${webhookDeliveries.body}`, needles), mentions(sql`coalesce(${webhookDeliveries.lastResponseExcerpt}, '')`, needles)),
      ),
    );
}

/**
 * True while a pending delivery is leased to an attempt in flight: a claim moves
 * `next_attempt_at` to the lease's end and stamps `last_attempt_at` and `updated_at` with
 * the same instant, and nothing else touches the row until the attempt's outcome (or a
 * release) does. An outcome recorded in the very instant of its claim looks the same,
 * and then merely costs that delivery one retry. Webhook and adapter deliveries alike.
 */
function leased(d: typeof webhookDeliveries | typeof adapterDeliveries, now: Date): SQL {
  return sql`(${d.status} = 'pending' and ${d.nextAttemptAt} > ${now.toISOString()}::timestamptz and ${d.lastAttemptAt} = ${d.updatedAt})`;
}

/**
 * Rewrites a delivery's stored body and excerpt. With `fail`, a pending delivery is also
 * stopped for good (`failed`, `subject_deleted`). Either way an attempt in flight, which
 * read the old body when it was claimed, loses its compare-and-set: with `fail` because
 * the delivery is no longer pending, otherwise because its attempt count moves on (as a
 * new claim would), so the outcome is dropped and the delivery is sent again, redacted,
 * when the lease runs out.
 */
export async function rewriteDelivery(
  tx: Transaction,
  id: string,
  values: { body: string; lastResponseExcerpt: string | null; fail: boolean; at: Date },
): Promise<void> {
  const d = webhookDeliveries;
  await tx
    .update(d)
    .set({
      body: values.body,
      lastResponseExcerpt: values.lastResponseExcerpt,
      updatedAt: values.at,
      attempts: sql`case when ${leased(d, values.at)} then ${d.attempts} + 1 else ${d.attempts} end`,
      ...(values.fail ? { status: "failed" as const, lastError: "subject_deleted" } : {}),
    })
    .where(eq(d.id, id));
}

/**
 * Moves the attempt count on for each adapter delivery of the given events that is in
 * flight (see `rewriteDelivery`): the adapter was handed the payload before it was
 * redacted, so its outcome is dropped and the delivery runs again after the lease, with
 * the redacted payload. @returns How many.
 */
export async function supersedeAdapterAttempts(tx: Transaction, eventIds: readonly string[], now: Date): Promise<number> {
  if (eventIds.length === 0) return 0;
  const d = adapterDeliveries;
  const rows = await tx
    .update(d)
    .set({ attempts: sql`${d.attempts} + 1`, updatedAt: now })
    .where(and(inArray(d.eventId, [...eventIds]), leased(d, now)))
    .returning({ id: d.id });
  return rows.length;
}

/** The company's adapter deliveries whose last error mentions any of `needles` (an adapter's own message). */
export async function listAdapterErrorsMentioning(ex: Executor, companyId: string, needles: readonly string[]) {
  return ex
    .select({ id: adapterDeliveries.id, lastError: adapterDeliveries.lastError })
    .from(adapterDeliveries)
    .where(and(eq(adapterDeliveries.companyId, companyId), mentions(sql`coalesce(${adapterDeliveries.lastError}, '')`, needles)));
}

export async function setAdapterError(tx: Transaction, id: string, lastError: string): Promise<void> {
  await tx.update(adapterDeliveries).set({ lastError }).where(eq(adapterDeliveries.id, id));
}

/** The company's import runs whose counts or report mention any of `needles`. */
export async function listImportRunsMentioning(ex: Executor, companyId: string, needles: readonly string[]) {
  return ex
    .select({ id: importRuns.id, counts: importRuns.counts, report: importRuns.report, sourceFileName: importRuns.sourceFileName })
    .from(importRuns)
    .where(
      and(
        eq(importRuns.companyId, companyId),
        or(mentions(sql`${importRuns.report}::text`, needles), mentions(sql`${importRuns.counts}::text`, needles), mentions(sql`${importRuns.sourceFileName}`, needles)),
      ),
    );
}

export async function setImportRunText(tx: Transaction, id: string, values: { counts: unknown; report: unknown; sourceFileName: string }): Promise<void> {
  await tx.update(importRuns).set(values).where(eq(importRuns.id, id));
}

/** The company's remaining audit rows whose before or after snapshot mentions any of `needles`. */
export async function listAuditMentioning(ex: Executor, companyId: string, needles: readonly string[]) {
  return ex
    .select({ id: auditLog.id, before: auditLog.before, after: auditLog.after })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.companyId, companyId),
        or(mentions(sql`coalesce(${auditLog.before}::text, '')`, needles), mentions(sql`coalesce(${auditLog.after}::text, '')`, needles)),
      ),
    );
}

export async function setAuditSnapshots(tx: Transaction, id: string, values: { before: unknown; after: unknown }): Promise<void> {
  await tx.update(auditLog).set(values).where(eq(auditLog.id, id));
}

/** The company's leave requests whose note or decision note mentions any of `needles`. */
export async function listNotesMentioning(ex: Executor, companyId: string, needles: readonly string[]) {
  return ex
    .select({ id: leaveRequests.id, note: leaveRequests.note, decisionNote: leaveRequests.decisionNote })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.companyId, companyId),
        or(mentions(sql`coalesce(${leaveRequests.note}, '')`, needles), mentions(sql`coalesce(${leaveRequests.decisionNote}, '')`, needles)),
      ),
    );
}

export async function setNotes(tx: Transaction, id: string, values: { note: string | null; decisionNote: string | null }): Promise<void> {
  await tx.update(leaveRequests).set(values).where(eq(leaveRequests.id, id));
}

/** A label an admin typed on a company setting: an API key's or catalog entry's name, a webhook's description. */
export interface SettingLabel {
  kind: "api_key" | "webhook_endpoint" | "department" | "leave_type" | "holiday";
  id: string;
  text: string;
}

/**
 * The company's setting labels that mention any of `needles`: API key names, webhook
 * endpoint descriptions (deleted endpoints too), and department, leave type and holiday
 * names. Never an endpoint's URL, which says where it sends.
 */
export async function listSettingLabelsMentioning(ex: Executor, companyId: string, needles: readonly string[]): Promise<SettingLabel[]> {
  const [keys, endpoints, depts, types, days] = await Promise.all([
    ex.select({ id: apiKeys.id, text: apiKeys.name }).from(apiKeys).where(and(eq(apiKeys.companyId, companyId), mentions(sql`${apiKeys.name}`, needles))),
    ex
      .select({ id: webhookEndpoints.id, text: webhookEndpoints.description })
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.companyId, companyId), mentions(sql`${webhookEndpoints.description}`, needles))),
    ex.select({ id: departments.id, text: departments.name }).from(departments).where(and(eq(departments.companyId, companyId), mentions(sql`${departments.name}`, needles))),
    ex.select({ id: leaveTypes.id, text: leaveTypes.name }).from(leaveTypes).where(and(eq(leaveTypes.companyId, companyId), mentions(sql`${leaveTypes.name}`, needles))),
    ex.select({ id: holidays.id, text: holidays.name }).from(holidays).where(and(eq(holidays.companyId, companyId), mentions(sql`${holidays.name}`, needles))),
  ]);
  const tag = (kind: SettingLabel["kind"]) => (r: { id: string; text: string }): SettingLabel => ({ kind, ...r });
  return [...keys.map(tag("api_key")), ...endpoints.map(tag("webhook_endpoint")), ...depts.map(tag("department")), ...types.map(tag("leave_type")), ...days.map(tag("holiday"))];
}

export async function setSettingLabel(tx: Transaction, label: Pick<SettingLabel, "kind" | "id">, text: string): Promise<void> {
  switch (label.kind) {
    case "api_key":
      await tx.update(apiKeys).set({ name: text }).where(eq(apiKeys.id, label.id));
      return;
    case "webhook_endpoint":
      await tx.update(webhookEndpoints).set({ description: text }).where(eq(webhookEndpoints.id, label.id));
      return;
    case "department":
      await tx.update(departments).set({ name: text }).where(eq(departments.id, label.id));
      return;
    case "leave_type":
      await tx.update(leaveTypes).set({ name: text }).where(eq(leaveTypes.id, label.id));
      return;
    case "holiday":
      await tx.update(holidays).set({ name: text }).where(eq(holidays.id, label.id));
      return;
  }
}

/** Schedules a full scrub of a deactivated person. */
export async function scheduleScrub(tx: Transaction, companyId: string, userId: string, values: { at: Date; requestedBy: string }): Promise<void> {
  await tx
    .update(user)
    .set({ scrubScheduledAt: values.at, scrubRequestedBy: values.requestedBy })
    .where(and(eq(user.id, userId), eq(user.companyId, companyId)));
}

/** Clears a scheduled scrub. @returns Whether one was scheduled. */
export async function clearScrubSchedule(tx: Transaction, companyId: string, userId: string): Promise<boolean> {
  const rows = await tx
    .update(user)
    .set({ scrubScheduledAt: null, scrubRequestedBy: null })
    .where(and(eq(user.id, userId), eq(user.companyId, companyId), isNotNull(user.scrubScheduledAt)))
    .returning({ id: user.id });
  return rows.length === 1;
}

/** Who asked for a person's scheduled scrub, read under the member lock. */
export async function findScrubRequest(ex: Executor, companyId: string, userId: string) {
  const [row] = await ex
    .select({ scrubScheduledAt: user.scrubScheduledAt, scrubRequestedBy: user.scrubRequestedBy })
    .from(user)
    .where(and(eq(user.id, userId), eq(user.companyId, companyId)));
  return row;
}

/** Where a pass over due scrubs stopped: the last one read. */
export interface DueScrubCursor {
  at: Date;
  id: string;
}

/**
 * Scheduled scrubs due at `now`, across companies, soonest first, after `cursor` when
 * given (keyset paging, so scrubs that cannot run yet never hide the ones behind them).
 * Served by `user_scrub_scheduled_idx`.
 */
export async function listDueScrubs(ex: Executor, now: Date, limit: number, cursor?: DueScrubCursor) {
  return ex
    .select({ id: user.id, companyId: user.companyId, scrubScheduledAt: user.scrubScheduledAt })
    .from(user)
    .where(
      and(
        isNotNull(user.scrubScheduledAt),
        lte(user.scrubScheduledAt, now),
        isNull(user.deletedAt),
        cursor ? sql`(${user.scrubScheduledAt}, ${user.id}) > (${cursor.at.toISOString()}::timestamptz, ${cursor.id})` : undefined,
      ),
    )
    .orderBy(asc(user.scrubScheduledAt), asc(user.id))
    .limit(limit);
}

const approver = alias(user, "approver");

/** The person's own leave requests for their records export, oldest first, with type and approver names. */
export async function listRequestsForExport(ex: Executor, companyId: string, userId: string) {
  return ex
    .select({
      id: leaveRequests.id,
      leaveTypeCode: leaveTypes.code,
      leaveTypeName: leaveTypes.name,
      startDate: leaveRequests.startDate,
      endDate: leaveRequests.endDate,
      dayPortion: leaveRequests.dayPortion,
      days: leaveRequests.days,
      status: leaveRequests.status,
      note: leaveRequests.note,
      approverName: approver.name,
      approverEmail: approver.email,
      decidedAt: leaveRequests.decidedAt,
      decisionNote: leaveRequests.decisionNote,
      createdAt: leaveRequests.createdAt,
    })
    .from(leaveRequests)
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
    .leftJoin(approver, eq(approver.id, leaveRequests.approverId))
    .where(and(eq(leaveRequests.companyId, companyId), eq(leaveRequests.userId, userId)))
    .orderBy(asc(leaveRequests.startDate), asc(leaveRequests.id));
}

/** Distinct years with an allowance row or booked leave for the person, ascending. */
export async function listRecordYears(ex: Executor, companyId: string, userId: string): Promise<number[]> {
  const [fromAllowances, fromRequests] = await Promise.all([
    ex.selectDistinct({ year: allowances.year }).from(allowances).where(eq(allowances.userId, userId)),
    ex
      .selectDistinct({ year: leaveRequestDays.year })
      .from(leaveRequestDays)
      .innerJoin(leaveRequests, eq(leaveRequests.id, leaveRequestDays.requestId))
      .where(and(eq(leaveRequests.companyId, companyId), eq(leaveRequests.userId, userId), inArray(leaveRequests.status, ["pending", "approved"]))),
  ]);
  return [...new Set([...fromAllowances, ...fromRequests].map((r) => Number(r.year)))].sort((a, b) => a - b);
}
