import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { executeRows } from "@/db/rows";
import * as schema from "@/db/schema";
import type { Database } from "@/db/types";
import { toActor } from "@/domain/actor";
import { byUser, CHANGE_PROCESSES } from "@/domain/change-source";
import { readTimeOffSqlite } from "@/server/importers/timeoff/sqlite-reader";
import { decideLeaveRequest, listApprovalInbox } from "@/server/services/approvals";
import { getBalanceSummary } from "@/server/services/balances";
import { cancelLeaveRequest, getDashboard } from "@/server/services/leave-requests";
import { runYearRollover } from "@/server/services/rollover";
import { importTimeOff, type TimeOffImportInput } from "@/server/services/timeoff-import";
import { DatabaseSync } from "node:sqlite";
import { buildTimeOffFixtureThrough } from "../support/timeoff-carry-forward";
import { buildTimeOffFixture, FIXTURE_EXPECTED_2026, FIXTURE_QUINN_2027, type FixtureData, fixtureLeave, T, U } from "../support/timeoff-fixture";
import { rejectsWith } from "./assertions";
import { requestsOf } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

const TABLES = {
  user: schema.user,
  session: schema.session,
  account: schema.account,
  verification: schema.verification,
  departments: schema.departments,
  leaveTypes: schema.leaveTypes,
  allowances: schema.allowances,
  holidays: schema.holidays,
  leaveRequests: schema.leaveRequests,
  leaveRequestDays: schema.leaveRequestDays,
  auditLog: schema.auditLog,
  eventsOutbox: schema.eventsOutbox,
  importRuns: schema.importRuns,
  companies: schema.companies,
};

async function rowCounts(db: Database): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [name, table] of Object.entries(TABLES)) out[name] = await db.$count(table);
  return out;
}

/** The seeded admin, who runs the import (`--actor`) in most tests. */
const SEED_ADMIN = "peter@example.org";

/** A company as `docker compose up` seeds it: the four default leave types and one admin with allowances. */
async function seedFreshDeploy(db: Database, adminEmail = SEED_ADMIN) {
  const [company] = await db.insert(schema.companies).values({ name: "My Company" }).returning();
  const types = await db
    .insert(schema.leaveTypes)
    .values([
      { companyId: company.id, code: "PTO", name: "PTO (Scheduled Time Off)", defaultAllowanceDays: 15, sortOrder: 0 },
      { companyId: company.id, code: "EMERGENCY", name: "Emergency Leave", defaultAllowanceDays: 3, sortOrder: 1 },
      { companyId: company.id, code: "SICK", name: "Sick Leave", defaultAllowanceDays: 5, sortOrder: 2 },
      { companyId: company.id, code: "BONUS", name: "Bonus Time Off", defaultAllowanceDays: 0, sortOrder: 3 },
    ])
    .returning();
  const [admin] = await db
    .insert(schema.user)
    .values({ id: randomUUID(), email: adminEmail, name: "peter", emailVerified: true, companyId: company.id, role: "admin", canSelfApprove: true })
    .returning();
  await db.insert(schema.allowances).values(types.map((t) => ({ userId: admin.id, leaveTypeId: t.id, year: 2026, days: t.defaultAllowanceDays ?? 0 })));
  return { companyId: company.id, adminId: admin.id };
}

describe("TimeOff import", { skip }, () => {
  let dir: string;
  let fileNo = 0;
  const databases: TestDatabase[] = [];
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ooohm-timeoff-"));
  });
  after(async () => {
    for (const d of databases) await d.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function freshDb(): Promise<Database> {
    const t = await createTestDatabase();
    databases.push(t);
    return t.db;
  }

  /**
   * Writes a fixture file and returns an import input for it, run by the seeded admin
   * (`SEED_ADMIN`) into an existing company, or by TimeOff's admin Alice into a new one.
   */
  function fixture(target: TimeOffImportInput["target"], mutate?: (d: FixtureData) => void, extra: Partial<TimeOffImportInput> = {}): TimeOffImportInput {
    const file = path.join(dir, `timeoff-${++fileNo}.sqlite`);
    buildTimeOffFixture(file, mutate);
    return {
      snapshot: readTimeOffSqlite(file),
      source: { sha256: createHash("sha256").update(readFileSync(file)).digest("hex"), fileName: path.basename(file) },
      target,
      actorEmail: "companyId" in target ? SEED_ADMIN : "alice@example.com",
      mergePoolTypes: true,
      ...extra,
    };
  }

  test("a dry run computes the whole import and leaves the database untouched", async () => {
    const db = await freshDb();
    const { companyId } = await seedFreshDeploy(db);
    const ctx = createTestContext(db);
    const beforeCounts = await rowCounts(db);

    const report = await importTimeOff(ctx, fixture({ companyId }));

    assert.equal(report.outcome, "dry_run");
    assert.equal(report.importRunId, null);
    assert.deepEqual(await rowCounts(db), beforeCounts, "nothing was written");
    assert.equal(report.counts.people.created, 13);
    assert.equal(report.reconciliation.mismatches.length, 0);
    assert.ok(report.reconciliation.rows.length > 0);
  });

  test("apply imports everyone and every balance equals TimeOff's, through the dashboard's own balance code", async () => {
    const db = await freshDb();
    const { companyId, adminId } = await seedFreshDeploy(db);
    const ctx = createTestContext(db);
    const outboxBefore = await db.$count(schema.eventsOutbox);

    const report = await importTimeOff(ctx, fixture({ companyId }, undefined, { apply: true }));

    assert.equal(report.outcome, "applied");
    assert.ok(report.importRunId);
    assert.deepEqual(
      report.reconciliation.rows.filter((r) => r.diff !== 0),
      [],
      "every person-year reconciles to zero",
    );
    const current = Object.fromEntries(report.reconciliation.rows.filter((r) => r.year === 2026).map((r) => [r.email, r.timeoff]));
    assert.deepEqual(current, FIXTURE_EXPECTED_2026);

    // What each person sees on their dashboard: remaining after pending, pending apart.
    const people = await db.select().from(schema.user).where(eq(schema.user.companyId, companyId));
    for (const [email, expected] of Object.entries(FIXTURE_EXPECTED_2026)) {
      const p = people.find((x) => x.email === email)!;
      const summary = await getBalanceSummary(ctx, { id: p.id, companyId, role: p.role, canSelfApprove: p.canSelfApprove, source: byUser(p.id) }, 2026);
      const pool = summary.items.find((i) => i.name === "Holiday")!;
      assert.ok(pool.balance.tracked, email);
      if (pool.balance.tracked) assert.equal(pool.balance.remaining + pool.balance.pending, expected, email);
    }
    const olivia = people.find((p) => p.email === "olivia@example.com")!;
    const oliviaSummary = await getBalanceSummary(ctx, { id: olivia.id, companyId, role: olivia.role, canSelfApprove: false, source: byUser(olivia.id) }, 2026);
    const oliviaPool = oliviaSummary.items.find((i) => i.name === "Holiday")!.balance;
    assert.deepEqual(oliviaPool.tracked && [oliviaPool.remaining, oliviaPool.pending], [22, 3], "pending shows apart and is subtracted");

    // People: the seed admin stays, the duplicate-case Henry is one person, nobody can sign in yet.
    assert.equal(people.length, 14);
    assert.equal(people.filter((p) => p.email === "henry@example.com").length, 1);
    assert.equal(people.find((p) => p.id === adminId)?.role, "admin");
    assert.deepEqual(
      Object.fromEntries(people.filter((p) => !p.isActive).map((p) => [p.email, p.isActive])),
      { "gina@example.com": false },
      "only who left is inactive; Nina never signed in to TimeOff but still works here",
    );
    assert.equal(await db.$count(schema.session), 0, "no sessions");
    assert.equal(await db.$count(schema.account), 0, "no account links");
    assert.equal(await db.$count(schema.verification), 0, "no sign-in tokens");
    const byEmail = new Map(people.map((p) => [p.email, p]));
    assert.equal(byEmail.get("carol@example.com")!.managerId, byEmail.get("bob@example.com")!.id);
    assert.equal(byEmail.get("bob@example.com")!.role, "manager");
    assert.equal(byEmail.get("alice@example.com")!.role, "admin");
    assert.equal(byEmail.get("alice@example.com")!.canSelfApprove, true);

    // Quinn starts next year: nothing to take this year, the pro-rated allowance in the start year.
    const quinn = byEmail.get("quinn@example.com")!;
    const quinn2027 = (await getBalanceSummary(ctx, { id: quinn.id, companyId, role: quinn.role, canSelfApprove: false, source: byUser(quinn.id) }, 2027)).items.find((i) => i.name === "Holiday")!.balance;
    assert.deepEqual(quinn2027.tracked && [quinn2027.allowance, quinn2027.remaining], [20, FIXTURE_QUINN_2027]);
    assert.deepEqual(
      report.reconciliation.rows.filter((r) => r.email === "quinn@example.com").map((r) => [r.year, r.timeoff, r.ooohm]),
      [
        [2026, 0, 0],
        [2027, FIXTURE_QUINN_2027, FIXTURE_QUINN_2027],
      ],
    );

    // Ivan's pending request goes to his manager under OOOhm's rule, not to TimeOff's stored approver (Alice).
    const ivan = byEmail.get("ivan@example.com")!;
    assert.equal(ivan.managerId, olivia.id);
    const [ivanPending] = await db
      .select()
      .from(schema.leaveRequests)
      .where(and(eq(schema.leaveRequests.userId, ivan.id), eq(schema.leaveRequests.status, "pending")));
    assert.equal(ivanPending.approverId, olivia.id);
    const oliviaActor = { id: olivia.id, companyId, role: olivia.role, canSelfApprove: olivia.canSelfApprove, source: byUser(olivia.id) };
    assert.deepEqual((await listApprovalInbox(ctx, oliviaActor)).items.map((r) => r.id), [ivanPending.id], "in her inbox");
    const [ivanAudit] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, ivanPending.id));
    assert.equal((ivanAudit.after as { timeoffApproverId?: string }).timeoffApproverId, byEmail.get("alice@example.com")!.id, "TimeOff's approver kept for reference");
    // Decided history keeps TimeOff's decider.
    const [aliceApproved] = await db.select().from(schema.leaveRequests).where(and(eq(schema.leaveRequests.userId, byEmail.get("carol@example.com")!.id), eq(schema.leaveRequests.startDate, "2026-04-06")));
    assert.equal(aliceApproved.approverId, byEmail.get("alice@example.com")!.id);

    // Leave types: the pool, Sick untracked, Jury Duty limited; the seed's unused defaults archived.
    const types = await db.select().from(schema.leaveTypes).where(eq(schema.leaveTypes.companyId, companyId));
    const active = types
      .filter((t) => t.archivedAt === null)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((t) => [t.code, t.countsAgainstAllowance, t.defaultAllowanceDays, t.carryoverEnabled]);
    assert.deepEqual(active, [
      ["HOLIDAY", true, null, true],
      ["SICK", false, null, false],
      ["JURY_DUTY", true, 5, false],
    ], "TimeOff's order, the pool first (the request form's default); the seeded Sick Leave matched by name");
    assert.deepEqual(types.filter((t) => t.archivedAt !== null).map((t) => t.code).sort(), ["BONUS", "EMERGENCY", "PTO"]);

    // Requests: Dave's Monday-afternoon-to-Wednesday-morning leave is three OOOhm requests.
    const dave = byEmail.get("dave@example.com")!;
    const daveRequests = await db
      .select()
      .from(schema.leaveRequests)
      .where(and(eq(schema.leaveRequests.userId, dave.id), eq(schema.leaveRequests.startDate, "2026-03-02")));
    assert.deepEqual(daveRequests.map((r) => [r.dayPortion, r.days]), [["pm", 0.5]]);
    const frank = byEmail.get("frank@example.com")!;
    const frankStatuses = await db.select({ status: schema.leaveRequests.status }).from(schema.leaveRequests).where(eq(schema.leaveRequests.userId, frank.id));
    assert.deepEqual(frankStatuses.map((r) => r.status).sort(), ["approved", "approved"], "pended revoke imports as approved");

    // Audit: one row per imported thing, all the admin's who ran it, via the import, and
    // marked; one outbox event in all, attributed the same way.
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.companyId, companyId));
    const actions = audit.reduce<Record<string, number>>((acc, a) => ({ ...acc, [a.action]: (acc[a.action] ?? 0) + 1 }), {});
    assert.equal(actions["import.user"], 13);
    assert.equal(actions["import.leave_request"], report.counts.leaveRequests.total);
    assert.equal(actions["import.allowance"], report.counts.allowances);
    assert.equal(actions["import.completed"], 1);
    assert.ok(audit.length > 13);
    assert.deepEqual(
      [...new Set(audit.map((a) => JSON.stringify([a.actorKind, a.actorId, a.actorVia, a.actorProcess, a.apiKeyId])))],
      [JSON.stringify(["user", adminId, "timeoff_import", null, null])],
      "every audit row: the seeded admin who ran it, via the TimeOff import",
    );
    assert.ok(audit.every((a) => (a.after as { source?: string }).source === "import:timeoff"));
    assert.deepEqual(report.actor, { userId: adminId, email: SEED_ADMIN });
    const events = await db.select().from(schema.eventsOutbox);
    assert.equal(events.length - outboxBefore, 1);
    const [event] = events;
    assert.equal(event.type, "import.completed");
    assert.equal(JSON.stringify(event.payload).includes("@"), false, "no personal data in the event");
    assert.deepEqual((event.payload as { counts: { people: number } }).counts.people, 13);
    const attribution = event.payload as { actorId: unknown; actor: unknown };
    assert.deepEqual(
      { actorId: attribution.actorId, actor: attribution.actor },
      { actorId: adminId, actor: { type: "user", id: adminId, via: CHANGE_PROCESSES.timeoffImport } },
    );
    const completed = audit.find((a) => a.action === "import.completed")!;
    assert.ok(
      Object.values(completed.after as Record<string, unknown>).every((v) => v === null || typeof v !== "object"),
      "flat fields, so the audit viewer can show each one",
    );

    const [run] = await db.select().from(schema.importRuns);
    assert.equal(run.id, report.importRunId);
    assert.equal(run.sourceSha256, report.source.sha256);

    // The nightly year rollover leaves every imported balance where the import put it.
    const rollover = await runYearRollover(ctx, 2025);
    assert.equal(rollover.carried, 0, "TimeOff's carried-over days are what OOOhm's rollover computes");
    for (const [email, expected] of Object.entries(FIXTURE_EXPECTED_2026)) {
      const p = people.find((x) => x.email === email)!;
      const pool = (await getBalanceSummary(ctx, { id: p.id, companyId, role: p.role, canSelfApprove: p.canSelfApprove, source: byUser(p.id) }, 2026)).items.find(
        (i) => i.name === "Holiday",
      )!.balance;
      assert.equal(pool.tracked && pool.remaining + pool.pending, expected, `${email} after the rollover`);
    }

    // Olivia can decide the request routed to her.
    const approved = await decideLeaveRequest(ctx, oliviaActor, { requestId: ivanPending.id, decision: "approve" });
    assert.deepEqual([approved.status, approved.approverId], ["approved", olivia.id]);
  });

  test("the same file cannot be imported twice, not even as a dry run", async () => {
    const db = await freshDb();
    const { companyId } = await seedFreshDeploy(db);
    const ctx = createTestContext(db);
    const input = fixture({ companyId }, undefined, { apply: true });
    assert.equal((await importTimeOff(ctx, input)).outcome, "applied");
    const counts = await rowCounts(db);

    await rejectsWith(importTimeOff(ctx, input), "import_refused");
    await rejectsWith(importTimeOff(ctx, { ...input, apply: false }), "import_refused");
    await rejectsWith(importTimeOff(ctx, { ...input, force: true }), "import_refused");
    assert.deepEqual(await rowCounts(db), counts);
  });

  test("a newer export of the same data into an imported company is refused, even with --force", async () => {
    const db = await freshDb();
    const { companyId } = await seedFreshDeploy(db);
    const ctx = createTestContext(db);
    assert.equal((await importTimeOff(ctx, fixture({ companyId }, undefined, { apply: true }))).outcome, "applied");
    const counts = await rowCounts(db);

    // The same data in different bytes, as a second `.backup` of a running TimeOff gives:
    // a session row in a table the importer never reads.
    const file = path.join(dir, `timeoff-${++fileNo}.sqlite`);
    buildTimeOffFixture(file);
    const sqlite = new DatabaseSync(file);
    sqlite.exec(`create table "Sessions" (sid text primary key, data text); insert into "Sessions" values ('s1', '{}')`);
    sqlite.close();
    const again: TimeOffImportInput = {
      snapshot: readTimeOffSqlite(file),
      source: { sha256: createHash("sha256").update(readFileSync(file)).digest("hex"), fileName: path.basename(file) },
      target: { companyId },
      actorEmail: SEED_ADMIN,
      mergePoolTypes: true,
    };
    assert.notEqual(again.source.sha256, (await db.select().from(schema.importRuns))[0].sourceSha256, "a different file");

    for (const extra of [{}, { apply: true }, { apply: true, force: true }, { apply: true, force: true, acceptMismatch: true }]) {
      await assert.rejects(importTimeOff(ctx, { ...again, ...extra }), (err: Error & { code?: string }) => {
        assert.equal(err.code, "import_refused");
        assert.match(err.message, /already holds a TimeOff import/);
        return true;
      });
    }
    assert.deepEqual(await rowCounts(db), counts, "no leave request was inserted a second time");
  });

  test("the fixture carried forward to a later year still reconciles to zero in that year", async () => {
    const db = await freshDb();
    const { companyId } = await seedFreshDeploy(db);
    const ctx = createTestContext(db, { now: new Date("2028-03-01T15:00:00Z") });
    const file = path.join(dir, `timeoff-${++fileNo}.sqlite`);
    const data = buildTimeOffFixtureThrough(file, 2028);
    assert.deepEqual(
      data.adjustments.filter((a) => a.user_id === U.quinn).map((a) => [a.year, a.carried_over_allowance]),
      [[2027, 0], [2028, 5]],
      "Quinn starts in 2027, so carries nothing into it and 5 of 20 out of it",
    );

    const report = await importTimeOff(ctx, {
      snapshot: readTimeOffSqlite(file),
      source: { sha256: createHash("sha256").update(readFileSync(file)).digest("hex"), fileName: path.basename(file) },
      target: { companyId },
      actorEmail: SEED_ADMIN,
      mergePoolTypes: true,
      apply: true,
    });

    assert.equal(report.reconciliation.currentYear, 2028);
    assert.deepEqual(report.reconciliation.mismatches, []);
    assert.equal(report.outcome, "applied");
    assert.ok(report.reconciliation.rows.filter((r) => r.year === 2028).length >= 10);
  });

  test("the uncarried fixture imported in a later year mismatches on carry-over and rolls back", async () => {
    const db = await freshDb();
    const { companyId } = await seedFreshDeploy(db);
    const ctx = createTestContext(db, { now: new Date("2027-01-15T15:00:00Z") });
    const report = await importTimeOff(ctx, fixture({ companyId }, undefined, { apply: true }));
    assert.equal(report.outcome, "rolled_back");
    assert.ok(report.reconciliation.currentYearMismatches > 0);
    for (const m of report.reconciliation.mismatches.filter((x) => x.year === 2027)) assert.match(m.reasons.join(" "), /Carried over into 2027/);
  });

  test("a current-year mismatch rolls the whole apply back; --accept-mismatch commits it", async () => {
    const db = await freshDb();
    const { companyId } = await seedFreshDeploy(db);
    const ctx = createTestContext(db);
    // Dec 31 (afternoon) to Jan 2: TimeOff takes half a day off the 2026 part too, OOOhm does not.
    const quirk = (d: FixtureData) => void fixtureLeave(d, { userId: U.dave, leaveTypeId: T.holiday, start: "2025-12-31", end: "2026-01-02", status: 2, dayPartStart: 3 });
    const counts = await rowCounts(db);

    const refused = await importTimeOff(ctx, fixture({ companyId }, quirk, { apply: true }));
    assert.equal(refused.outcome, "rolled_back");
    assert.deepEqual(await rowCounts(db), counts, "nothing committed");
    assert.deepEqual(
      refused.reconciliation.mismatches.map((m) => [m.email, m.year, m.timeoff, m.ooohm, m.diff]),
      [["dave@example.com", 2026, 27, 26.5, -0.5]],
    );
    assert.match(refused.reconciliation.mismatches[0].reasons.join(" "), /half-day rule/);
    assert.equal(refused.reconciliation.currentYearMismatches, 1);

    // TimeOff also stored no carry for Alice, so OOOhm's rollover step corrects it to 5.
    const outboxBefore = await db.$count(schema.eventsOutbox);
    const accepted = await importTimeOff(ctx, fixture({ companyId }, (d) => {
      quirk(d);
      d.adjustments.find((a) => a.user_id === U.alice && a.year === 2026)!.carried_over_allowance = 0;
      d.companies[0].name = "Accepted";
    }, { apply: true, acceptMismatch: true }));
    assert.equal(accepted.outcome, "applied");
    assert.deepEqual(accepted.reconciliation.mismatches.map((m) => [m.email, m.year, m.diff]), [
      ["alice@example.com", 2026, 5],
      ["dave@example.com", 2026, -0.5],
    ]);
    const events = await db.select().from(schema.eventsOutbox);
    assert.deepEqual(events.map((e) => e.type), ["import.completed"], "the carry correction writes no balance.adjusted event");
    assert.equal(events.length - outboxBefore, 1);
    assert.equal((events[0].payload as { mismatches: number }).mismatches, 2);
    const carryAudit = await db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "import.allowance"), sql`${schema.auditLog.after}->>'reason' = 'carryover'`));
    assert.deepEqual(carryAudit.map((a) => (a.after as { carriedOverDays: number }).carriedOverDays), [5], "audited as an import row instead");
    const [peter] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, SEED_ADMIN));
    assert.deepEqual(
      carryAudit.map((a) => [a.actorKind, a.actorId, a.actorVia, a.actorProcess]),
      [["user", peter.id, "timeoff_import", null]],
      "the import caused the carry, so it is the import's change, not the nightly rollover's",
    );
  });

  test("a holiday the company already has, and TimeOff does not, shows as a mismatch instead of passing silently", async () => {
    const db = await freshDb();
    const { companyId } = await seedFreshDeploy(db);
    const ctx = createTestContext(db);
    await db.insert(schema.holidays).values({ companyId, date: "2026-03-10", name: "Company day" });

    const report = await importTimeOff(ctx, fixture({ companyId }, undefined, { apply: true }));

    assert.equal(report.outcome, "rolled_back");
    assert.deepEqual(report.reconciliation.mismatches.map((m) => [m.email, m.year, m.timeoff, m.ooohm]), [["alice@example.com", 2026, 20, 21]]);
    assert.match(report.reconciliation.mismatches[0].reasons.join(" "), /already has a holiday/);
  });

  test("the import must leave an active admin: a new company with no TimeOff admin is refused", async () => {
    const db = await freshDb();
    const ctx = createTestContext(db);
    const noAdmins = (d: FixtureData) => d.users.forEach((u) => (u.admin = 0));
    await rejectsWith(importTimeOff(ctx, fixture({ createCompany: "Chykalophia" }, noAdmins, { apply: true })), "import_refused");
    assert.equal(await db.$count(schema.companies), 0, "the new company was rolled back too");

    // Into a seeded company the seed admin is enough.
    const { companyId } = await seedFreshDeploy(db);
    const report = await importTimeOff(ctx, fixture({ companyId }, noAdmins, { apply: true }));
    assert.equal(report.outcome, "applied");

    // And a new company with a TimeOff admin is created with TimeOff's settings.
    const created = await importTimeOff(ctx, fixture({ createCompany: "Second" }, (d) => {
      for (const u of d.users) u.email = String(u.email).replace("@", "+2@");
    }, { apply: true, actorEmail: "alice+2@example.com" }));
    assert.equal(created.outcome, "applied");
    assert.deepEqual([created.company.created, created.company.timezone, created.company.workingDays], [true, "America/Chicago", [1, 2, 3, 4, 5]]);

    // Alice only exists once the import has created her, and every change is hers.
    const [alice] = await db.select().from(schema.user).where(eq(schema.user.email, "alice+2@example.com"));
    assert.deepEqual(created.actor, { userId: alice.id, email: "alice+2@example.com" });
    const sources = await db
      .selectDistinct({ kind: schema.auditLog.actorKind, id: schema.auditLog.actorId, via: schema.auditLog.actorVia })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.companyId, created.company.id));
    assert.deepEqual(sources, [{ kind: "user", id: alice.id, via: "timeoff_import" }]);
    const [event] = await db.select().from(schema.eventsOutbox).where(eq(schema.eventsOutbox.companyId, created.company.id));
    assert.deepEqual((event.payload as { actor: unknown }).actor, { type: "user", id: alice.id, via: "timeoff_import" });
  });

  test("--actor must be an active admin of the target company after the import; otherwise nothing is written", async () => {
    const db = await freshDb();
    const { companyId, adminId } = await seedFreshDeploy(db);
    const ctx = createTestContext(db);
    const [other] = await db.insert(schema.companies).values({ name: "Other" }).returning();
    await db.insert(schema.user).values({ id: randomUUID(), email: "boss@other.example", name: "Boss", companyId: other.id, role: "admin" });
    const counts = await rowCounts(db);
    const ginaAdmin = (d: FixtureData) => void (d.users.find((u) => u.email === "gina@example.com")!.admin = 1);

    const refusals: [string, TimeOffImportInput, RegExp][] = [
      ["nobody has that email", fixture({ companyId }, undefined, { apply: true, actorEmail: "nobody@example.org" }), /not a member of company "My Company"/],
      ["an admin of another company", fixture({ companyId }, undefined, { apply: true, actorEmail: "boss@other.example" }), /not a member/],
      ["someone the import brings in, not an admin", fixture({ companyId }, undefined, { apply: true, actorEmail: "carol@example.com" }), /not an active admin/],
      ["an imported admin who has left", fixture({ companyId }, ginaAdmin, { apply: true, actorEmail: "gina@example.com" }), /not an active admin/],
      ["a dry run, too", fixture({ companyId }, undefined, { actorEmail: "carol@example.com" }), /not an active admin/],
      ["a new company, named by a non-admin", fixture({ createCompany: "New" }, undefined, { apply: true, actorEmail: "carol@example.com" }), /not an active admin of company "New"/],
    ];
    for (const [why, input, message] of refusals) {
      await assert.rejects(importTimeOff(ctx, input), (err: Error & { code?: string }) => {
        assert.equal(err.code, "import_refused", why);
        assert.match(err.message, message, why);
        return true;
      });
      assert.deepEqual(await rowCounts(db), counts, `${why}: nothing written`);
    }
    await rejectsWith(importTimeOff(ctx, fixture({ companyId }, undefined, { actorEmail: "not an email" })), "invalid_input");
    assert.deepEqual(await rowCounts(db), counts);

    // Case and spaces don't matter; the refusals recorded nothing, so the import still runs.
    const report = await importTimeOff(ctx, fixture({ companyId }, undefined, { apply: true, actorEmail: "  Peter@Example.org " }));
    assert.equal(report.outcome, "applied");
    assert.deepEqual(report.actor, { userId: adminId, email: SEED_ADMIN });
    const viaImport = await db.$count(schema.auditLog, and(eq(schema.auditLog.actorId, adminId), eq(schema.auditLog.actorVia, CHANGE_PROCESSES.timeoffImport)));
    assert.equal(viaImport, await db.$count(schema.auditLog, eq(schema.auditLog.companyId, companyId)));
  });

  test("a company that already has leave or members is refused unless --force; emails of another company are left out", async () => {
    const db = await freshDb();
    const { companyId, adminId } = await seedFreshDeploy(db);
    const ctx = createTestContext(db);
    await db.insert(schema.user).values({ id: randomUUID(), email: "someone@example.org", name: "Someone", companyId });
    const [other] = await db.insert(schema.companies).values({ name: "Other" }).returning();
    await db.insert(schema.user).values({ id: randomUUID(), email: "paula@example.com", name: "Paula elsewhere", companyId: other.id });

    await rejectsWith(importTimeOff(ctx, fixture({ companyId }, undefined, { apply: true })), "import_refused");

    const report = await importTimeOff(ctx, fixture({ companyId }, (d) => void (d.companies[0].name = "Forced"), { apply: true, force: true }));
    assert.equal(report.outcome, "applied");
    assert.deepEqual(report.conflicts.filter((c) => c.code === "email_in_other_company").map((c) => c.email), ["paula@example.com"]);
    const [paula] = await db.select().from(schema.user).where(eq(schema.user.email, "paula@example.com"));
    assert.equal(paula.companyId, other.id, "the other company's account is untouched");
    const [admin] = await db.select().from(schema.user).where(eq(schema.user.id, adminId));
    assert.equal(admin.role, "admin");
  });

  test("several allowance types without --merge-pool-types are refused with the options", async () => {
    const db = await freshDb();
    const { companyId } = await seedFreshDeploy(db);
    const ctx = createTestContext(db);
    await assert.rejects(importTimeOff(ctx, fixture({ companyId }, undefined, { mergePoolTypes: false })), /--merge-pool-types/);
  });

  test("an existing person with the same email is updated, never demoted", async () => {
    const db = await freshDb();
    const { companyId, adminId } = await seedFreshDeploy(db, "bob@example.com");
    const ctx = createTestContext(db);
    // Bob runs it: TimeOff has him as a manager, but he stays the admin he already is.
    const report = await importTimeOff(ctx, fixture({ companyId }, undefined, { apply: true, actorEmail: "bob@example.com" }));
    assert.equal(report.outcome, "applied");
    assert.equal(report.counts.people.updated, 1);
    const [bob] = await db.select().from(schema.user).where(eq(schema.user.id, adminId));
    assert.deepEqual([bob.name, bob.role, bob.canSelfApprove], ["Bob Boss", "admin", true]);
    const rows = await executeRows(db, sql`select year, days, carried_over_days from allowances a join leave_types t on t.id = a.leave_type_id where a.user_id = ${adminId} and t.code = 'HOLIDAY' order by year`);
    assert.deepEqual([...rows].map((r) => [r.year, Number(r.days), Number(r.carried_over_days)]), [[2025, 25, 0], [2026, 25, 5]]);
  });

  test("an imported 2025 request shows no Cancel button and cannot be cancelled; one ending in 2026 still can", async () => {
    const db = await freshDb();
    const { companyId } = await seedFreshDeploy(db);
    const ctx = createTestContext(db); // today: 2026-11-01
    await importTimeOff(ctx, fixture({ companyId }, undefined, { apply: true }));
    const actorFor = async (email: string) => {
      const [row] = await db.select().from(schema.user).where(eq(schema.user.email, email));
      return toActor(row)!;
    };

    // Alice's Aug 4-8 2025 holiday, approved in TimeOff.
    const alice = await actorFor("alice@example.com");
    const [summer] = (await requestsOf(db, alice.id)).filter((r) => r.startDate === "2025-08-04");
    assert.equal(summer.status, "approved");
    const dashboard = await getDashboard(ctx, alice);
    assert.equal(dashboard.requests.find((r) => r.id === summer.id)?.cancellable, false, "no Cancel button");
    const eventsBefore = await db.$count(schema.eventsOutbox);
    await rejectsWith(cancelLeaveRequest(ctx, alice, summer.id), "past_year_closed");
    const [still] = await db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.id, summer.id));
    assert.equal(still.status, "approved");
    assert.equal(await db.$count(schema.eventsOutbox), eventsBefore, "nothing recorded");

    // Erin's Dec 29 2025 to Jan 5 2026 crosses New Year, so part of it is in the open year.
    const erin = await actorFor("erin@example.com");
    const [newYear] = (await requestsOf(db, erin.id)).filter((r) => r.startDate === "2025-12-29");
    assert.equal((await getDashboard(ctx, erin)).requests.find((r) => r.id === newYear.id)?.cancellable, true);
    assert.equal((await cancelLeaveRequest(ctx, erin, newYear.id)).status, "cancelled");
  });
});
