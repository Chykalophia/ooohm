import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { tombstoneEmail } from "@/domain/person-deletion";
import type { WebhookFetch } from "@/lib/safe-fetch";
import { updateCompanySettings } from "@/server/services/admin-company";
import { createApiKey } from "@/server/services/api-keys";
import { listBalancesForApi } from "@/server/services/api-v1";
import { setAllowanceOverride } from "@/server/services/admin-allowances";
import {
  deactivatePerson,
  getPersonFormOptions,
  invitePerson,
  listPeople,
  reactivatePerson,
  updatePerson,
} from "@/server/services/admin-people";
import {
  cancelScheduledDeletion,
  deletePerson,
  exportPersonRecords,
  getDeletionPreview,
  runDueScrubs,
} from "@/server/services/admin-people-deletion";
import { decideLeaveRequest } from "@/server/services/approvals";
import { getAuditLog } from "@/server/services/audit-log";
import { issueCalendarFeed } from "@/server/services/calendar-feeds";
import { getTeamCalendar } from "@/server/services/calendar";
import { submitLeaveRequest } from "@/server/services/leave-requests";
import { dispatchOutboxBatch } from "@/server/services/outbox-dispatch";
import { DAILY_JOBS, runDueJobs } from "@/server/services/scheduled-jobs";
import { deliverDueWebhooks } from "@/server/services/webhook-delivery";
import { createWebhookEndpoint } from "@/server/services/webhooks";
import { rejectsWith } from "./assertions";
import { companyAudit, companyEvents, decidable, seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

const NOW = new Date("2026-11-02T15:00:00Z");
const DAY = 86_400_000;

/** A recognizable name: none of its parts occurs anywhere else in a fresh test database. */
const ZEB_NAME = "Zebulon Quixtrade";
/** The name they were invited under, before a rename: it must go too. */
const FORMER_NAME = "Zebediah Marchetti";
const NAME_PARTS = ["zebulon", "quixtrade", "zebediah", "marchetti"];

async function userRow(db: Database, id: string) {
  const [row] = await db.select().from(schema.user).where(eq(schema.user.id, id));
  return row;
}

/**
 * Every text, varchar, json(b) and text[] column of every table in `public`, read from
 * `information_schema`, so a table added later is scanned too.
 */
async function textColumns(t: TestDatabase) {
  const rows = await t.query<{ table_name: string; column_name: string }>`
    select c.table_name, c.column_name from information_schema.columns c
    join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
    where c.table_schema = 'public' and tb.table_type = 'BASE TABLE'
      and (c.data_type in ('text', 'character varying', 'character', 'json', 'jsonb') or (c.data_type = 'ARRAY' and c.udt_name in ('_text', '_varchar')))
    order by c.table_name, c.column_name`;
  return rows.map((r) => ({ table: r.table_name, column: r.column_name }));
}

/** Where, in the whole database, any of `needles` occurs (case-insensitively). */
async function findTraces(t: TestDatabase, needles: readonly string[]): Promise<string[]> {
  const hits: string[] = [];
  const columns = await textColumns(t);
  assert.ok(columns.length > 40, `the scan sees the schema (${columns.length} columns)`);
  for (const { table, column } of columns) {
    for (const needle of needles) {
      const [row] = await t.query<{
        n: number;
      }>`select count(*)::int as n from ${sql.identifier(table)} where strpos(lower(${sql.identifier(column)}::text), ${needle.toLowerCase()}) > 0`;
      if (Number(row.n) > 0) hits.push(`${table}.${column} contains "${needle}" (${row.n})`);
    }
  }
  return hits;
}

/** A fake webhook transport that records what it was sent. */
function recorder() {
  const bodies: string[] = [];
  const fetch: WebhookFetch = async (_url, init) => {
    bodies.push(init.body);
    return new Response("ok", { status: 200 });
  };
  return { fetch, bodies };
}

describe("admin: deleting people", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  /**
   * A company with a long-standing, deactivated person (Zebulon) who has everything a
   * person can leave behind: an invite, leave of their own (decided, with notes), leave of
   * someone else they approved, allowances over two years, a calendar link, a session, a
   * Google link and an unused sign-in link, events already sent to a webhook and one still
   * pending, an import report naming them, a colleague's note and an allowance reason on a
   * colleague's audit row that mention them. They were invited under another name
   * ({@link FORMER_NAME}) and renamed since.
   */
  async function richCompany(options: { grace?: boolean } = {}) {
    const co = await seedCompany(t.db, { boss: { role: "admin", createdAt: "2026-01-01T00:00:00Z" }, mia: { managerKey: "boss" } });
    const { boss, mia } = co.people;
    const ctx = createTestContext(t.db, { now: NOW });
    const zebEmail = `zebulon.quixtrade-${randomUUID().slice(0, 6)}@example.com`;
    if (options.grace) {
      await updateCompanySettings(ctx, boss, {
        name: "Acme",
        timezone: "UTC",
        workingDays: [1, 2, 3, 4, 5],
        allowancePolicy: "annual_calendar_year",
        deletionGrace: true,
      });
    }
    const { endpoint } = await createWebhookEndpoint(ctx, boss, {
      url: `https://hooks-${randomUUID().slice(0, 8)}.example.com/ooohm`,
      description: `Payroll sync, ask ${ZEB_NAME} (${zebEmail})`,
      eventTypes: ["user.created", "user.updated", "user.deactivated", "user.deleted", "leave.requested", "leave.approved"],
    });
    // Labels admins type on company settings name people too.
    await createApiKey(ctx, boss, { name: `${ZEB_NAME} - Zapier` });

    const zebRow = await invitePerson(ctx, boss, {
      email: zebEmail,
      name: FORMER_NAME,
      departmentId: null,
      managerId: boss.id,
      role: "manager",
      canSelfApprove: false,
    });
    await updatePerson(ctx, boss, zebRow.id, {
      name: ZEB_NAME,
      departmentId: null,
      managerId: boss.id,
      role: "manager",
      canSelfApprove: false,
    });
    const zeb: Actor = {
      id: zebRow.id,
      companyId: co.companyId,
      role: "manager",
      canSelfApprove: false,
      source: { kind: "user", userId: zebRow.id },
    };

    // Zebulon's own leave, approved by the boss with a note; allowances for two years.
    const own = await submitLeaveRequest(ctx, zeb, {
      leaveTypeId: co.pto,
      startDate: "2026-11-09",
      endDate: "2026-11-10",
      dayPortion: "full",
      note: "Dentist, private",
    });
    await decideLeaveRequest(ctx, boss, { requestId: own.id, decision: "approve", reason: "Enjoy" });
    await submitLeaveRequest(ctx, zeb, { leaveTypeId: co.pto, startDate: "2026-12-14", endDate: "2026-12-14", dayPortion: "full" });
    await setAllowanceOverride(ctx, boss, {
      userId: zeb.id,
      leaveTypeId: co.pto,
      year: 2026,
      days: 20,
      adjustmentDays: 0,
      reason: "Senior",
    });
    await setAllowanceOverride(ctx, boss, {
      userId: zeb.id,
      leaveTypeId: co.pto,
      year: 2027,
      days: 22,
      adjustmentDays: 0,
      reason: "Senior",
    });

    // Mia reports to Zebulon for a while; Zebulon approves her leave, then she moves back.
    await updatePerson(ctx, boss, mia.id, {
      name: mia.name,
      departmentId: null,
      managerId: zeb.id,
      role: "employee",
      canSelfApprove: false,
    });
    const miaLeave = await submitLeaveRequest(ctx, mia, {
      leaveTypeId: co.pto,
      startDate: "2026-11-16",
      endDate: "2026-11-16",
      dayPortion: "full",
      note: `Swapping with ${ZEB_NAME} (${zebEmail})`,
    });
    await decideLeaveRequest(ctx, zeb, { requestId: miaLeave.id, decision: "approve", reason: "Covered" });
    await updatePerson(ctx, boss, mia.id, {
      name: mia.name,
      departmentId: null,
      managerId: boss.id,
      role: "employee",
      canSelfApprove: false,
    });
    // Text that names them with odd spacing and nothing else of theirs (no email, no id).
    const miaCover = await submitLeaveRequest(ctx, mia, {
      leaveTypeId: co.pto,
      startDate: "2026-11-23",
      endDate: "2026-11-23",
      dayPortion: "full",
      note: "Cover: Zebulon  Quixtrade",
    });
    await decideLeaveRequest(ctx, boss, { requestId: miaCover.id, decision: "approve", reason: "OK, Zebulon\nQuixtrade agreed" });

    await issueCalendarFeed(ctx, zeb, "personal");
    await t.db
      .insert(schema.account)
      .values({ id: randomUUID(), accountId: `google-${randomUUID()}`, providerId: "google", userId: zeb.id });
    await t.db.insert(schema.verification).values({
      id: randomUUID(),
      identifier: randomUUID(),
      value: JSON.stringify({ type: "magic-link", email: zebEmail, name: "" }),
      expiresAt: new Date(NOW.getTime() + DAY),
    });
    // Another person's unused link must stay.
    const otherLink = randomUUID();
    await t.db.insert(schema.verification).values({
      id: otherLink,
      identifier: randomUUID(),
      value: JSON.stringify({ type: "magic-link", email: `someone-else-${randomUUID().slice(0, 6)}@example.com`, name: "" }),
      expiresAt: new Date(NOW.getTime() + DAY),
    });
    await t.db.insert(schema.importRuns).values({
      companyId: co.companyId,
      source: "timeoff",
      sourceSha256: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      sourceFileName: "timeoff.sqlite",
      counts: { people: { created: 3 } },
      report: {
        warnings: [{ code: "never_signed_in", email: zebEmail, message: `${zebEmail} never signed in to TimeOff.` }],
        reconciliation: { rows: [{ userId: zeb.id, email: zebEmail, name: ZEB_NAME, year: 2026 }] },
      },
    });
    // An audit row about someone else that quotes Zebulon, as the app writes it: Mia's
    // allowance snapshot (with her userId) and the reason an admin typed.
    await setAllowanceOverride(ctx, boss, {
      userId: mia.id,
      leaveTypeId: co.pto,
      year: 2026,
      days: 21,
      adjustmentDays: 0,
      reason: `Covering for ${ZEB_NAME} (once ${FORMER_NAME}), ${zebEmail}`,
    });

    // Everything so far goes to the webhook; then Zebulon is deactivated, whose event waits.
    await dispatchOutboxBatch(ctx);
    const sent = recorder();
    await deliverDueWebhooks(ctx, { fetch: sent.fetch });
    assert.ok(
      sent.bodies.some((b) => b.includes(zebEmail)),
      "the webhook received Zebulon's email before the delete",
    );
    await deactivatePerson(ctx, boss, zeb.id);
    // A session that outlived deactivation (one created in the same instant): a delete removes it all the same.
    await t.db
      .insert(schema.session)
      .values({ id: randomUUID(), token: randomUUID(), userId: zeb.id, expiresAt: new Date(NOW.getTime() + 30 * DAY) });
    await dispatchOutboxBatch(ctx);
    // A pending body that is not JSON (written by some earlier version) cannot be redacted.
    await t.db.insert(schema.webhookDeliveries).values({
      companyId: co.companyId,
      endpointId: endpoint.id,
      eventId: randomUUID(),
      eventType: "user.deactivated",
      body: `legacy ${zebEmail} ${ZEB_NAME}`,
      nextAttemptAt: NOW,
    });
    // A pending JSON body and a receiver's reply holding the address after URL separators.
    await t.db.insert(schema.webhookDeliveries).values({
      companyId: co.companyId,
      endpointId: endpoint.id,
      eventId: randomUUID(),
      eventType: "leave.requested",
      body: JSON.stringify({ id: randomUUID(), type: "leave.requested", data: { note: `see /users/${zebEmail}?ref=x` } }),
      lastResponseExcerpt: `GET /contacts/${zebEmail} returned 404`,
      nextAttemptAt: NOW,
    });
    const [anyEvent] = await companyEvents(t.db, co.companyId);
    await t.db.insert(schema.adapterDeliveries).values({
      companyId: co.companyId,
      adapterId: "test-adapter",
      eventId: anyEvent.id,
      status: "failed",
      nextAttemptAt: NOW,
      lastError: `lookup?email=${zebEmail} not found`,
    });
    await ctx.settle();
    return { co, ctx, boss, mia, zeb, zebEmail, own, miaLeave, endpoint, otherLink };
  }

  test("a full scrub leaves nothing about the person anywhere, keeps what belongs to others, and records exactly one row and one event", async () => {
    const { co, ctx, boss, mia, zeb, zebEmail, miaLeave, endpoint, otherLink } = await richCompany();
    const auditBefore = await companyAudit(t.db, co.companyId);
    const eventsBefore = await companyEvents(t.db, co.companyId);

    const preview = await getDeletionPreview(ctx, boss, zeb.id);
    assert.equal(preview.blocked, false);
    assert.deepEqual(preview.counts, {
      leaveRequests: 2,
      pendingRequests: 1,
      balanceYears: 2,
      allowanceRows: 2,
      auditEntries: auditBefore.filter((a) => a.subjectUserId === zeb.id).length,
      sessions: 1,
      accounts: 1,
      calendarFeeds: 1,
    });
    assert.ok(preview.counts.auditEntries >= 8, `audit entries about Zebulon: ${preview.counts.auditEntries}`);

    const outcome = await deletePerson(ctx, boss, zeb.id, { mode: "scrubbed", confirmName: "zebulon  quixtrade" });
    assert.equal(outcome.outcome, "deleted");
    if (outcome.outcome !== "deleted") return;
    assert.equal(outcome.tombstoneName, `Former employee #${zeb.id.replaceAll("-", "").slice(0, 6)}`);

    // The tombstone.
    const row = await userRow(t.db, zeb.id);
    assert.deepEqual(
      [
        row.name,
        row.email,
        row.isActive,
        row.deletionMode,
        row.deletedAt?.getTime(),
        row.role,
        row.managerId,
        row.departmentId,
        row.emailVerified,
        row.scrubScheduledAt,
      ],
      [outcome.tombstoneName, tombstoneEmail(zeb.id), false, "scrubbed", NOW.getTime(), "employee", null, null, false, null],
    );

    // Their own records are gone; sign-in pieces too; another person's unused link stays.
    const count = async (q: Promise<unknown[]>) => (await q).length;
    assert.equal(await count(t.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.userId, zeb.id))), 0);
    assert.equal(await count(t.db.select().from(schema.allowances).where(eq(schema.allowances.userId, zeb.id))), 0);
    assert.equal(await count(t.db.select().from(schema.session).where(eq(schema.session.userId, zeb.id))), 0);
    assert.equal(await count(t.db.select().from(schema.account).where(eq(schema.account.userId, zeb.id))), 0);
    assert.equal(await count(t.db.select().from(schema.calendarFeedTokens).where(eq(schema.calendarFeedTokens.userId, zeb.id))), 0);
    assert.equal(
      await count(
        t.db
          .select()
          .from(schema.verification)
          .where(sql`strpos(${schema.verification.value}, ${zebEmail}) > 0`),
      ),
      0,
    );
    assert.equal(
      await count(t.db.select().from(schema.verification).where(eq(schema.verification.id, otherLink))),
      1,
      "another person's link stays",
    );

    // What belongs to others stays: Mia's request, decided by the tombstone, with her note redacted.
    const [miaAfter] = await t.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.id, miaLeave.id));
    assert.deepEqual([miaAfter.status, miaAfter.approverId, miaAfter.decisionNote], ["approved", zeb.id, "Covered"]);
    assert.equal(miaAfter.note, `Swapping with ${outcome.tombstoneName} (${tombstoneEmail(zeb.id)})`);
    const decidedByZeb = (await companyAudit(t.db, co.companyId)).filter((a) => a.actorId === zeb.id);
    assert.ok(
      decidedByZeb.some((a) => a.action === "leave_request.approved" && a.subjectUserId === mia.id),
      "their approval of Mia's leave is still on record",
    );

    // Exactly one audit row about them now: the delete, by the admin, counts only.
    const aboutZeb = (await companyAudit(t.db, co.companyId)).filter((a) => a.subjectUserId === zeb.id);
    assert.equal(aboutZeb.length, 1);
    const [deleted] = aboutZeb;
    assert.deepEqual(
      [deleted.action, deleted.actorKind, deleted.actorId, deleted.entityId, deleted.before],
      ["user.deleted", "user", boss.id, zeb.id, null],
    );
    assert.deepEqual(Object.keys(deleted.after as object), ["mode", "counts"]);
    const counts = (deleted.after as { mode: string; counts: Record<string, number> }).counts;
    assert.equal((deleted.after as { mode: string }).mode, "scrubbed");
    assert.deepEqual(
      [
        counts.leaveRequestsDeleted,
        counts.allowancesDeleted,
        counts.auditEntriesDeleted,
        counts.sessionsDeleted,
        counts.accountsDeleted,
        counts.verificationsDeleted,
        counts.calendarFeedsDeleted,
      ],
      [2, 2, preview.counts.auditEntries, 1, 1, 1, 1],
    );
    assert.equal(counts.deliveriesFailed, 1, "the pending body that is not JSON is stopped");
    assert.ok(
      counts.eventsRedacted > 0 && counts.deliveriesRedacted > 0 && counts.importRunsRedacted === 1 && counts.auditEntriesRedacted >= 1,
      JSON.stringify(counts),
    );
    assert.deepEqual(
      [counts.notesRedacted, counts.settingsRedacted, counts.pendingRequestsWithdrawn],
      [2, 2, 0],
      "two notes, the key name and the webhook description; a scrub deletes rather than withdraws",
    );
    const auditAfter = await companyAudit(t.db, co.companyId);
    assert.equal(auditAfter.length, auditBefore.length - preview.counts.auditEntries + 1, "only their rows went, and one came");

    // Exactly one new event, with no personal data.
    const eventsAfter = await companyEvents(t.db, co.companyId);
    assert.equal(eventsAfter.length, eventsBefore.length + 1);
    const userDeleted = eventsAfter.filter((e) => e.type === "user.deleted");
    assert.equal(userDeleted.length, 1);
    assert.deepEqual(userDeleted[0].payload, {
      userId: zeb.id,
      mode: "scrubbed",
      deletedAt: NOW.toISOString(),
      actorId: boss.id,
      actor: { type: "user", id: boss.id },
    });

    // Nothing left: every text, varchar and jsonb column of every table, case-insensitively.
    assert.deepEqual(await findTraces(t, [...NAME_PARTS, zebEmail]), []);
    const miaReason = (await companyAudit(t.db, co.companyId)).find(
      (a) => a.subjectUserId === mia.id && (a.after as { reason?: string } | null)?.reason,
    );
    assert.equal(
      (miaReason?.after as { userId: string; reason: string }).reason,
      `Covering for ${outcome.tombstoneName} (once ${outcome.tombstoneName}), ${tombstoneEmail(zeb.id)}`,
      "a reason on a colleague's row loses their names, the former one too",
    );
    assert.equal((miaReason?.after as { userId: string }).userId, mia.id);
    const [cover] = await t.db
      .select()
      .from(schema.leaveRequests)
      .where(eq(schema.leaveRequests.note, `Cover: ${outcome.tombstoneName}`));
    assert.equal(
      cover?.decisionNote,
      `OK, ${outcome.tombstoneName} agreed`,
      "a name split by two spaces or a line break is found and replaced",
    );
    const [key] = await t.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.companyId, co.companyId));
    assert.equal(key.name, `${outcome.tombstoneName} - Zapier`);
    const [ep] = await t.db.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, endpoint.id));
    assert.deepEqual([ep.description, ep.enabled], [`Payroll sync, ask ${outcome.tombstoneName} (${tombstoneEmail(zeb.id)})`, true]);

    // The pending delivery goes out redacted, with the new `user.deleted`; the stopped one never goes.
    await dispatchOutboxBatch(ctx);
    const sent = recorder();
    await deliverDueWebhooks(ctx, { fetch: sent.fetch });
    assert.ok(sent.bodies.length >= 2, `sent ${sent.bodies.length}`);
    for (const body of sent.bodies) assert.ok(!body.toLowerCase().includes("zebulon") && !body.includes(zebEmail), body);
    const stopped = await t.db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.lastError, "subject_deleted"));
    assert.deepEqual(
      stopped.map((d) => [d.endpointId, d.status]),
      [[endpoint.id, "failed"]],
    );

    // History names the tombstone; pickers, People and the team view never show it.
    const log = await getAuditLog(ctx, boss, { actorId: zeb.id });
    assert.ok(log.entries.length > 0 && log.entries.every((e) => e.actorLabel === outcome.tombstoneName));
    assert.ok(!log.people.some((p) => p.id === zeb.id), "not in the audit pickers");
    assert.ok(!(await listPeople(ctx, boss, { status: "all" })).people.some((p) => p.id === zeb.id));
    assert.ok(!(await getPersonFormOptions(ctx, boss, mia.id)).managers.some((m) => m.id === zeb.id));
    const team = await getTeamCalendar(ctx, boss, { month: "2026-11" });
    assert.ok(!team.people.some((p) => p.userId === zeb.id));
    await rejectsWith(getDeletionPreview(ctx, boss, zeb.id), "not_found");
    await rejectsWith(deletePerson(ctx, boss, zeb.id, { mode: "scrubbed", confirmName: outcome.tombstoneName }), "not_found");

    // Nothing new can be written for the tombstone, and the API reports nothing for it.
    await rejectsWith(
      setAllowanceOverride(ctx, boss, { userId: zeb.id, leaveTypeId: co.pto, year: 2026, days: 5, adjustmentDays: 0, reason: "late edit" }),
      "not_found",
    );
    assert.equal((await t.db.select().from(schema.allowances).where(eq(schema.allowances.userId, zeb.id))).length, 0);
    const client = { keyId: randomUUID(), companyId: co.companyId, scopes: ["read" as const] };
    assert.deepEqual((await listBalancesForApi(ctx, client, { year: 2026, userId: zeb.id })).data, []);
    assert.ok(
      (await listBalancesForApi(ctx, client, { year: 2026, userId: mia.id })).data.length > 0,
      "a living person still has balances",
    );
  });

  test("keep records: sign-in and email go, history stays under '<Name> (deleted)', and the address can be invited again as a new person", async () => {
    const { co, ctx, boss, zeb, zebEmail, own } = await richCompany();
    const eventsBefore = await companyEvents(t.db, co.companyId);
    const auditBefore = await companyAudit(t.db, co.companyId);
    const inboxBefore = await decidable(ctx, boss);
    assert.ok(
      inboxBefore.items.some((i) => i.requesterId === zeb.id),
      "their December request waits in Approvals",
    );
    const outcome = await deletePerson(ctx, boss, zeb.id, { mode: "records_kept", confirmName: ZEB_NAME });
    assert.equal(outcome.outcome, "deleted");
    if (outcome.outcome !== "deleted") return;

    // A request of theirs still waiting is withdrawn, counted in the one audit row; nobody is left to decide it.
    assert.equal(outcome.counts.pendingRequestsWithdrawn, 1);
    const theirs = await t.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.userId, zeb.id));
    assert.deepEqual(theirs.map((r) => r.status).sort(), ["approved", "cancelled"]);
    assert.ok(!(await decidable(ctx, boss)).items.some((i) => i.requesterId === zeb.id), "gone from Approvals");

    // Their kept balances are still served.
    const client = { keyId: randomUUID(), companyId: co.companyId, scopes: ["read" as const] };
    const kept = (await listBalancesForApi(ctx, client, { year: 2026, userId: zeb.id })).data;
    assert.deepEqual(
      kept.map((b) => [b.userId, b.leaveTypeId, b.allowance, b.used, b.pending]),
      [[zeb.id, co.pto, 20, 2, 0]],
    );

    const row = await userRow(t.db, zeb.id);
    assert.deepEqual(
      [row.name, row.email, row.deletionMode, row.isActive],
      [`${ZEB_NAME} (deleted)`, tombstoneEmail(zeb.id), "records_kept", false],
    );
    const [ownAfter] = await t.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.id, own.id));
    assert.deepEqual(
      [ownAfter.status, ownAfter.note, ownAfter.decisionNote],
      ["approved", "Dentist, private", "Enjoy"],
      "their history stays",
    );
    assert.equal((await t.db.select().from(schema.allowances).where(eq(schema.allowances.userId, zeb.id))).length, 2);
    assert.equal((await t.db.select().from(schema.session).where(eq(schema.session.userId, zeb.id))).length, 0);
    assert.equal((await t.db.select().from(schema.account).where(eq(schema.account.userId, zeb.id))).length, 0);
    assert.equal((await t.db.select().from(schema.calendarFeedTokens).where(eq(schema.calendarFeedTokens.userId, zeb.id))).length, 0);

    const auditAfter = await companyAudit(t.db, co.companyId);
    assert.equal(auditAfter.length, auditBefore.length + 1, "nothing deleted from the audit log; one row added");
    const deleted = auditAfter.filter((a) => a.action === "user.deleted");
    assert.equal(deleted.length, 1);
    assert.equal((deleted[0].after as { mode: string }).mode, "records_kept");
    const eventsAfter = await companyEvents(t.db, co.companyId);
    assert.equal(eventsAfter.length, eventsBefore.length + 1);
    assert.deepEqual((eventsAfter.find((e) => e.type === "user.deleted")!.payload as { mode: string }).mode, "records_kept");

    // The email is gone everywhere; the name stays (that is the point of keeping records).
    assert.deepEqual(await findTraces(t, [zebEmail]), []);
    const created = auditAfter.find((a) => a.action === "user.created" && a.subjectUserId === zeb.id);
    assert.deepEqual(
      [(created?.after as { name: string }).name, (created?.after as { email: string }).email],
      [FORMER_NAME, tombstoneEmail(zeb.id)],
    );
    const log = await getAuditLog(ctx, boss, { subjectUserId: zeb.id });
    assert.ok(log.entries.length > 5 && log.entries.every((e) => e.subjectName === `${ZEB_NAME} (deleted)`));

    // Re-invite: a brand-new person, nothing linking them to the tombstone.
    const again = await invitePerson(ctx, boss, {
      email: zebEmail,
      name: ZEB_NAME,
      departmentId: null,
      managerId: null,
      role: "employee",
      canSelfApprove: false,
    });
    assert.notEqual(again.id, zeb.id);
    const fresh = await userRow(t.db, again.id);
    assert.deepEqual([fresh.email, fresh.isActive, fresh.deletedAt, fresh.managerId], [zebEmail, true, null, null]);
    assert.equal((await t.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.userId, again.id))).length, 0);
    assert.equal((await t.db.select().from(schema.allowances).where(eq(schema.allowances.userId, again.id))).length, 0);
    assert.equal((await userRow(t.db, zeb.id)).email, tombstoneEmail(zeb.id), "the tombstone is untouched");
    await ctx.settle();
    assert.deepEqual(ctx.signInLinks.at(-1), zebEmail);
  });

  test("guards: still active, manages people, has requests to decide, the last admin; each refused with nothing written", async () => {
    const co = await seedCompany(t.db, {
      boss: { role: "admin", createdAt: "2026-01-01T00:00:00Z" },
      mgr: { role: "manager", isActive: false },
      ana: { managerKey: "mgr" },
      emp: {},
    });
    const ctx = createTestContext(t.db, { now: NOW });
    const { boss, mgr, ana, emp } = co.people;
    const blockersOf = async (id: string, name: string) => {
      let blockers: unknown;
      await assert.rejects(
        deletePerson(ctx, boss, id, { mode: "scrubbed", confirmName: name }),
        (err: { code?: string; details?: unknown }) => {
          assert.equal(err.code, "deletion_blocked");
          blockers = err.details;
          return true;
        },
      );
      return blockers as { stillActive: boolean; reports: { id: string }[]; pendingApprovals: number; lastAdmin: boolean };
    };
    const auditCount = async () => (await companyAudit(t.db, co.companyId)).length;
    const before = await auditCount();

    // Still active.
    const active = await blockersOf(emp.id, emp.name);
    assert.deepEqual([active.stillActive, active.reports, active.pendingApprovals, active.lastAdmin], [true, [], 0, false]);

    // Manages people (inactive manager, Ana still reports to them).
    const manages = await blockersOf(mgr.id, mgr.name);
    assert.deepEqual([manages.stillActive, manages.reports.map((r) => r.id)], [false, [ana.id]]);
    const preview = await getDeletionPreview(ctx, boss, mgr.id);
    assert.deepEqual([preview.blocked, preview.blockers.reports.map((r) => r.name)], [true, ["Ana"]]);

    // Pending requests to decide.
    await t.db.update(schema.user).set({ managerId: null }).where(eq(schema.user.id, ana.id));
    const req = await submitLeaveRequest(ctx, ana, {
      leaveTypeId: co.pto,
      startDate: "2026-11-09",
      endDate: "2026-11-09",
      dayPortion: "full",
    });
    await t.db.update(schema.leaveRequests).set({ approverId: mgr.id }).where(eq(schema.leaveRequests.id, req.id));
    const pending = await blockersOf(mgr.id, mgr.name);
    assert.deepEqual([pending.reports, pending.pendingApprovals], [[], 1]);
    await t.db.update(schema.leaveRequests).set({ approverId: boss.id }).where(eq(schema.leaveRequests.id, req.id));

    // The last admin (still active, so refused twice over).
    const last = await blockersOf(boss.id, boss.name);
    assert.deepEqual([last.stillActive, last.lastAdmin], [true, true]);

    // Confirmation, mode, other companies, non-admins.
    await rejectsWith(deletePerson(ctx, boss, mgr.id, { mode: "scrubbed", confirmName: "Mg" }), "confirmation_mismatch");
    await rejectsWith(deletePerson(ctx, boss, mgr.id, { mode: "archived", confirmName: mgr.name }), "invalid_input");
    const other = await seedCompany(t.db, { admin2: { role: "admin" } });
    await rejectsWith(deletePerson(ctx, other.people.admin2, mgr.id, { mode: "scrubbed", confirmName: mgr.name }), "not_found");
    await rejectsWith(getDeletionPreview(ctx, other.people.admin2, mgr.id), "not_found");
    await rejectsWith(exportPersonRecords(ctx, other.people.admin2, mgr.id), "not_found");
    for (const who of [ana, emp]) {
      await rejectsWith(deletePerson(ctx, who, mgr.id, { mode: "scrubbed", confirmName: mgr.name }), "forbidden");
      await rejectsWith(getDeletionPreview(ctx, who, mgr.id), "forbidden");
      await rejectsWith(exportPersonRecords(ctx, who, mgr.id), "forbidden");
      await rejectsWith(cancelScheduledDeletion(ctx, who, mgr.id), "forbidden");
    }
    // A session that still says admin but whose row was demoted is refused too.
    await t.db.update(schema.user).set({ role: "employee" }).where(eq(schema.user.id, boss.id));
    await rejectsWith(deletePerson(ctx, boss, mgr.id, { mode: "scrubbed", confirmName: mgr.name }), "forbidden");
    await t.db.update(schema.user).set({ role: "admin" }).where(eq(schema.user.id, boss.id));

    assert.equal(await auditCount(), before + 1, "refusals wrote nothing (the one row is Ana's submit)");
    assert.equal((await userRow(t.db, mgr.id)).deletedAt, null);

    // Once nothing blocks, it goes.
    const done = await deletePerson(ctx, boss, mgr.id, { mode: "scrubbed", confirmName: mgr.name });
    assert.equal(done.outcome, "deleted");
  });

  test("grace period: a scrub is scheduled with undo, the daily job runs it when due, attributed to the system on the admin's behalf", async () => {
    const { co, ctx, boss, zeb, zebEmail } = await richCompany({ grace: true });

    const scheduled = await deletePerson(ctx, boss, zeb.id, { mode: "scrubbed", confirmName: ZEB_NAME });
    assert.equal(scheduled.outcome, "scheduled");
    if (scheduled.outcome !== "scheduled") return;
    assert.deepEqual([scheduled.scheduledFor.getTime(), scheduled.alreadyScheduled], [NOW.getTime() + 7 * DAY, false]);
    let row = await userRow(t.db, zeb.id);
    assert.deepEqual(
      [row.scrubScheduledAt?.getTime(), row.scrubRequestedBy, row.deletedAt, row.email],
      [NOW.getTime() + 7 * DAY, boss.id, null, zebEmail],
    );
    assert.equal((await companyAudit(t.db, co.companyId, "user.deletion_scheduled")).length, 1);
    assert.deepEqual(
      (await companyEvents(t.db, co.companyId, "user.deletion_scheduled")).map((e) => e.payload),
      [{ userId: zeb.id, scheduledFor: scheduled.scheduledFor.toISOString(), actorId: boss.id, actor: { type: "user", id: boss.id } }],
    );
    const listed = (await listPeople(ctx, boss, { status: "all" })).people.find((p) => p.id === zeb.id);
    assert.equal(listed?.scrubScheduledAt?.getTime(), scheduled.scheduledFor.getTime(), "the People list shows the date");

    // Asking again changes nothing; undo clears it (audited); doing undo again is a no-op.
    const later = createTestContext(t.db, { now: new Date(NOW.getTime() + 5 * DAY) });
    const again = await deletePerson(later, boss, zeb.id, { mode: "scrubbed", confirmName: ZEB_NAME });
    assert.deepEqual(
      again,
      { outcome: "scheduled", userId: zeb.id, scheduledFor: scheduled.scheduledFor, alreadyScheduled: true },
      "the date it already had",
    );
    assert.equal((await companyAudit(t.db, co.companyId, "user.deletion_scheduled")).length, 1);
    assert.equal(await cancelScheduledDeletion(ctx, boss, zeb.id), true);
    assert.equal(await cancelScheduledDeletion(ctx, boss, zeb.id), false);
    row = await userRow(t.db, zeb.id);
    assert.deepEqual([row.scrubScheduledAt, row.scrubRequestedBy], [null, null]);
    assert.deepEqual(
      (await companyEvents(t.db, co.companyId, "user.deletion_cancelled")).map((e) => (e.payload as { userId: string }).userId),
      [zeb.id],
    );

    // Reactivating cancels a schedule too (only a deactivated person can wait for one).
    await deletePerson(ctx, boss, zeb.id, { mode: "scrubbed", confirmName: ZEB_NAME });
    await reactivatePerson(ctx, boss, zeb.id);
    row = await userRow(t.db, zeb.id);
    assert.deepEqual([row.isActive, row.scrubScheduledAt], [true, null]);
    assert.equal((await companyEvents(t.db, co.companyId, "user.deletion_cancelled")).length, 2);
    await deactivatePerson(ctx, boss, zeb.id);

    // Scheduled again; the job does nothing before the date, and scrubs on it.
    await deletePerson(ctx, boss, zeb.id, { mode: "scrubbed", confirmName: ZEB_NAME });
    const early = createTestContext(t.db, { now: new Date(NOW.getTime() + 6 * DAY) });
    assert.deepEqual(await runDueScrubs(early), { scrubbed: 0, blocked: 0 });
    assert.equal((await userRow(t.db, zeb.id)).deletedAt, null);

    const due = new Date(NOW.getTime() + 7 * DAY + 60_000);
    const dueCtx = createTestContext(t.db, { now: due });
    assert.ok(Object.keys(DAILY_JOBS).includes("scheduled_scrub"));
    // Through the real daily job, as the worker, cron route and embedded tick run it.
    await t.db.update(schema.scheduledJobs).set({ nextRunAt: new Date(0) });
    assert.ok((await runDueJobs(dueCtx)).includes("scheduled_scrub"));
    row = await userRow(t.db, zeb.id);
    assert.deepEqual([row.deletionMode, row.deletedAt?.getTime(), row.scrubScheduledAt], ["scrubbed", due.getTime(), null]);

    const [deleted] = await companyAudit(t.db, co.companyId, "user.deleted");
    assert.deepEqual(
      [deleted.actorKind, deleted.actorId, deleted.actorProcess, deleted.actorRequestedBy, deleted.subjectUserId],
      ["system", null, "scheduled_scrub", boss.id, zeb.id],
    );
    const [event] = await companyEvents(t.db, co.companyId, "user.deleted");
    assert.deepEqual(event.payload, {
      userId: zeb.id,
      mode: "scrubbed",
      deletedAt: due.toISOString(),
      actorId: null,
      actor: { type: "system", process: "scheduled_scrub", requestedBy: boss.id },
    });
    const log = await getAuditLog(dueCtx, boss, { action: "user.deleted" });
    assert.equal(log.entries[0].actorLabel, "System: scheduled deletion, requested by Boss");
    assert.equal(
      (await companyAudit(t.db, co.companyId)).filter((a) => a.subjectUserId === zeb.id).length,
      1,
      "the schedule rows went with the rest",
    );
    assert.deepEqual(await runDueScrubs(dueCtx), { scrubbed: 0, blocked: 0 }, "nothing left to do");
  });

  test("grace period: a due scrub a rule now refuses waits; keeping records never waits and replaces a scheduled scrub", async () => {
    const co = await seedCompany(t.db, {
      boss: { role: "admin" },
      zed: { isActive: false },
      ana: {},
      kim: { isActive: false },
      lee: { isActive: false },
    });
    const ctx = createTestContext(t.db, { now: NOW });
    const { boss, zed, ana, kim, lee } = co.people;
    await updateCompanySettings(ctx, boss, {
      name: "Acme",
      timezone: "UTC",
      workingDays: [1, 2, 3, 4, 5],
      allowancePolicy: "annual_calendar_year",
      deletionGrace: true,
    });
    await deletePerson(ctx, boss, zed.id, { mode: "scrubbed", confirmName: "Zed" });
    // Lee's scrub falls due an hour after Zed's, so a run meets Zed's first.
    await deletePerson(createTestContext(t.db, { now: new Date(NOW.getTime() + 3_600_000) }), boss, lee.id, {
      mode: "scrubbed",
      confirmName: "Lee",
    });
    const req = await submitLeaveRequest(ctx, ana, {
      leaveTypeId: co.pto,
      startDate: "2026-11-09",
      endDate: "2026-11-09",
      dayPortion: "full",
    });
    await t.db.update(schema.leaveRequests).set({ approverId: zed.id }).where(eq(schema.leaveRequests.id, req.id));
    const later = createTestContext(t.db, { now: new Date(NOW.getTime() + 8 * DAY) });
    // A run that may carry out one scrub passes over Zed's (blocked) and does Lee's.
    assert.deepEqual(await runDueScrubs(later, { limit: 1 }), { scrubbed: 1, blocked: 1 });
    assert.equal((await userRow(t.db, lee.id)).deletionMode, "scrubbed", "a blocked scrub never holds up the ones behind it");
    assert.ok((await userRow(t.db, zed.id)).scrubScheduledAt, "still scheduled, retried on the next run");
    assert.deepEqual(await runDueScrubs(later), { scrubbed: 0, blocked: 1 });
    // The person page says why it waits; before the date it is only scheduled.
    const waiting = await getDeletionPreview(later, boss, zed.id);
    assert.deepEqual([waiting.scrubWaiting, waiting.blockers.pendingApprovals], [true, 1]);
    assert.equal((await getDeletionPreview(ctx, boss, zed.id)).scrubWaiting, false, "not yet due");

    await deletePerson(ctx, boss, kim.id, { mode: "scrubbed", confirmName: "Kim" });
    const kept = await deletePerson(ctx, boss, kim.id, { mode: "records_kept", confirmName: "Kim" });
    assert.equal(kept.outcome, "deleted");
    const row = await userRow(t.db, kim.id);
    assert.deepEqual([row.deletionMode, row.scrubScheduledAt, row.name], ["records_kept", null, "Kim (deleted)"]);
  });

  for (const mode of ["scrubbed", "records_kept"] as const) {
    test(`${mode}: a colleague whose address contains theirs (ted@ for ed@) keeps every row byte for byte, a pending delivery included`, async () => {
      const co = await seedCompany(t.db, { boss: { role: "admin" } });
      const { boss } = co.people;
      const ctx = createTestContext(t.db, { now: NOW });
      const domain = `acme-${randomUUID().slice(0, 8)}.example.com`;
      await createWebhookEndpoint(ctx, boss, {
        url: `https://hooks-${randomUUID().slice(0, 8)}.example.com/x`,
        description: "",
        eventTypes: ["user.created", "user.updated"],
      });
      const ed = await invitePerson(ctx, boss, {
        email: `ed@${domain}`,
        name: "Ed Stone",
        departmentId: null,
        managerId: null,
        role: "employee",
        canSelfApprove: false,
      });
      const ted = await invitePerson(ctx, boss, {
        email: `ted@${domain}`,
        name: "Ted Park",
        departmentId: null,
        managerId: null,
        role: "employee",
        canSelfApprove: false,
      });
      await updatePerson(ctx, boss, ted.id, {
        name: "Ted Park",
        departmentId: null,
        managerId: boss.id,
        role: "employee",
        canSelfApprove: false,
      });
      await deactivatePerson(ctx, boss, ed.id);
      await dispatchOutboxBatch(ctx);
      await ctx.settle();

      const tedAudit = async () =>
        (await companyAudit(t.db, co.companyId)).filter((a) => a.subjectUserId === ted.id).map((a) => JSON.stringify([a.before, a.after]));
      const tedEvents = async () =>
        (await companyEvents(t.db, co.companyId))
          .filter((e) => (e.payload as { userId?: string }).userId === ted.id)
          .map((e) => JSON.stringify(e.payload));
      const tedDeliveries = async () =>
        (await t.db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.companyId, co.companyId)))
          .filter((d) => d.body.includes(`"userId":"${ted.id}"`))
          .map((d) => [d.id, d.status, d.body]);
      const before = { audit: await tedAudit(), events: await tedEvents(), deliveries: await tedDeliveries() };
      assert.ok(before.audit.length >= 2 && before.events.length >= 2 && before.deliveries.length >= 2, JSON.stringify(before));
      assert.ok(before.deliveries.every(([, status]) => status === "pending"));

      await deletePerson(ctx, boss, ed.id, { mode, confirmName: "Ed Stone" });
      assert.deepEqual({ audit: await tedAudit(), events: await tedEvents(), deliveries: await tedDeliveries() }, before);

      const sent = recorder();
      await deliverDueWebhooks(ctx, { fetch: sent.fetch });
      const tedBodies = sent.bodies.filter((b) => b.includes(ted.id));
      assert.equal(tedBodies.length, before.deliveries.length);
      for (const body of tedBodies) assert.equal((JSON.parse(body) as { data: { email: string } }).data.email, `ted@${domain}`);
    });
  }

  test("a colleague with the same name keeps every record of theirs through the other's scrub", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db, { now: NOW });
    const person = (email: string) => ({
      email,
      name: "Sam Lee",
      departmentId: null,
      managerId: null,
      role: "employee",
      canSelfApprove: false,
    });
    const gone = await invitePerson(ctx, co.people.boss, person(`sam.a-${randomUUID().slice(0, 6)}@example.com`));
    const stays = await invitePerson(ctx, co.people.boss, person(`sam.b-${randomUUID().slice(0, 6)}@example.com`));
    // Free text on the surviving Sam Lee's own records: their note, and a reason on their allowance.
    const samB: Actor = {
      id: stays.id,
      companyId: co.companyId,
      role: "employee",
      canSelfApprove: false,
      source: { kind: "user", userId: stays.id },
    };
    const note = await submitLeaveRequest(ctx, samB, {
      leaveTypeId: co.pto,
      startDate: "2026-11-09",
      endDate: "2026-11-09",
      dayPortion: "full",
      note: "Sam Lee: dentist",
    });
    await setAllowanceOverride(ctx, co.people.boss, {
      userId: stays.id,
      leaveTypeId: co.pto,
      year: 2026,
      days: 22,
      adjustmentDays: 0,
      reason: "Raise for Sam Lee after review",
    });
    const theirAudit = async () =>
      (await companyAudit(t.db, co.companyId))
        .filter((a) => a.subjectUserId === stays.id)
        .map((a) => JSON.stringify([a.id, a.before, a.after]));
    const theirEvents = async () =>
      (await companyEvents(t.db, co.companyId))
        .filter((e) => (e.payload as { userId?: string }).userId === stays.id)
        .map((e) => JSON.stringify(e.payload));
    const before = { audit: await theirAudit(), events: await theirEvents() };
    assert.ok(before.audit.some((a) => a.includes("Raise for Sam Lee")) && before.events.length >= 3, JSON.stringify(before));
    await deactivatePerson(ctx, co.people.boss, gone.id);
    await deletePerson(ctx, co.people.boss, gone.id, { mode: "scrubbed", confirmName: "Sam Lee" });

    assert.deepEqual(
      { audit: await theirAudit(), events: await theirEvents() },
      before,
      "the namesake's records, free text included, are untouched",
    );
    const [noteAfter] = await t.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.id, note.id));
    assert.equal(noteAfter.note, "Sam Lee: dentist");

    const created = (await companyAudit(t.db, co.companyId, "user.created")).filter((a) => a.subjectUserId === stays.id);
    assert.deepEqual(
      created.map((a) => (a.after as { name: string; email: string }).name),
      ["Sam Lee"],
    );
    const events = (await companyEvents(t.db, co.companyId, "user.created")).map(
      (e) => e.payload as { userId: string; name: string; email: string },
    );
    assert.deepEqual(
      events.find((p) => p.userId === stays.id),
      { ...events.find((p) => p.userId === stays.id), name: "Sam Lee", email: stays.email },
    );
    assert.equal(events.find((p) => p.userId === gone.id)?.name, `Former employee #${gone.id.replaceAll("-", "").slice(0, 6)}`);
    assert.equal((await userRow(t.db, stays.id)).name, "Sam Lee");
  });

  test("keep records: their own pending request is withdrawn, so it never holds up deleting the approver it waited on", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, mgr: { role: "manager" }, kim: { managerKey: "mgr" } });
    const ctx = createTestContext(t.db, { now: NOW });
    const { boss, mgr, kim } = co.people;
    const req = await submitLeaveRequest(ctx, kim, {
      leaveTypeId: co.pto,
      startDate: "2026-11-09",
      endDate: "2026-11-09",
      dayPortion: "full",
    });
    await deactivatePerson(ctx, boss, kim.id);
    assert.equal((await decidable(ctx, mgr)).total, 1, "deactivating keeps their request waiting");

    const auditBefore = (await companyAudit(t.db, co.companyId)).length;
    const eventsBefore = (await companyEvents(t.db, co.companyId)).length;
    await deletePerson(ctx, boss, kim.id, { mode: "records_kept", confirmName: "Kim" });
    const [after] = await t.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.id, req.id));
    assert.equal(after.status, "cancelled");
    assert.equal((await decidable(ctx, mgr)).total, 0);
    await rejectsWith(decideLeaveRequest(ctx, boss, { requestId: req.id, decision: "approve" }), "invalid_transition");
    assert.deepEqual(
      [(await companyAudit(t.db, co.companyId)).length, (await companyEvents(t.db, co.companyId)).length],
      [auditBefore + 1, eventsBefore + 1],
      "still one audit row and one event: the withdrawal is counted in user.deleted",
    );

    await deactivatePerson(ctx, boss, mgr.id);
    assert.equal((await getDeletionPreview(ctx, boss, mgr.id)).blocked, false);
    assert.equal((await deletePerson(ctx, boss, mgr.id, { mode: "records_kept", confirmName: "Mgr" })).outcome, "deleted");
  });

  test("a webhook attempt in flight when the scrub commits loses its outcome, and the delivery goes again, redacted", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const { boss } = co.people;
    const ctx = createTestContext(t.db, { now: NOW });
    await createWebhookEndpoint(ctx, boss, {
      url: `https://hooks-${randomUUID().slice(0, 8)}.example.com/x`,
      description: "",
      eventTypes: ["user.created"],
    });
    const email = `quill.ostrander-${randomUUID().slice(0, 6)}@example.com`;
    const qo = await invitePerson(ctx, boss, {
      email,
      name: "Quill Ostrander",
      departmentId: null,
      managerId: null,
      role: "employee",
      canSelfApprove: false,
    });
    await deactivatePerson(ctx, boss, qo.id);
    await dispatchOutboxBatch(ctx);
    await ctx.settle();

    // The scrub commits while the POST of the claimed body is in flight.
    const first: string[] = [];
    const inFlight: WebhookFetch = async (_url, init) => {
      first.push(init.body);
      if (first.length === 1) await deletePerson(ctx, boss, qo.id, { mode: "scrubbed", confirmName: "Quill Ostrander" });
      return new Response("ok", { status: 200 });
    };
    await deliverDueWebhooks(ctx, { fetch: inFlight });
    assert.equal(first.length, 1);
    assert.ok(first[0].includes(email), "the attempt in flight had read the old body (a documented limit)");
    const [row] = await t.db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.companyId, co.companyId));
    assert.deepEqual([row.status, row.deliveredAt], ["pending", null], "its outcome is dropped, not recorded as delivered");
    assert.ok(!row.body.includes(email) && !row.body.includes("Quill"));

    // After the lease, it goes again with the redacted body, and that is what is recorded.
    const later = createTestContext(t.db, { now: new Date(NOW.getTime() + 10 * 60_000) });
    const again = recorder();
    await deliverDueWebhooks(later, { fetch: again.fetch });
    assert.equal(again.bodies.length, 1);
    assert.ok(!again.bodies[0].includes(email) && !again.bodies[0].includes("Quill"), again.bodies[0]);
    const [done] = await t.db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, row.id));
    assert.deepEqual([done.status, done.body], ["delivered", again.bodies[0]]);
  });

  test("the records export: requests, balances per year and audit entries, admin-only, audited, no formulas", async () => {
    const { co, ctx, boss, zeb, own } = await richCompany();
    await t.db.update(schema.leaveRequests).set({ note: '=HYPERLINK("x")' }).where(eq(schema.leaveRequests.id, own.id));
    const { fileName, csv } = await exportPersonRecords(ctx, boss, zeb.id);
    assert.equal(fileName, `ooohm-records-${zeb.id.replaceAll("-", "").slice(0, 6)}.csv`);
    const lines = csv.split("\r\n");
    assert.ok(lines[0].startsWith("record,id,date,leave_type"));
    assert.equal(lines.filter((l) => l.startsWith("leave_request,")).length, 2);
    const balances = lines.filter((l) => l.startsWith("balance,"));
    assert.ok(balances.some((l) => l.includes(",2026,20,")) && balances.some((l) => l.includes(",2027,22,")), balances.join("\n"));
    assert.ok(lines.filter((l) => l.startsWith("audit,")).length >= 8);
    assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`), "a formula-looking note is neutralized");
    const exported = await companyAudit(t.db, co.companyId, "user.records_exported");
    assert.deepEqual(
      exported.map((a) => [a.actorId, a.subjectUserId]),
      [[boss.id, zeb.id]],
    );
    assert.equal((await companyEvents(t.db, co.companyId, "user.records")).length, 0, "an export changes nothing, so no event");
  });
});
