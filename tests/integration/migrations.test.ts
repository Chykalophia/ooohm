import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { violatedConstraint } from "@/server/repositories/errors";
import { createTestDatabase, MIGRATIONS_FOLDER, skip, type TestDatabase } from "./harness";

interface Journal {
  entries: { idx: number; tag: string }[];
}

/** A copy of the migrations folder holding only the migrations before `tag`. */
async function migrationsBefore(tag: string): Promise<string> {
  const journal = JSON.parse(await readFile(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as Journal;
  const cut = journal.entries.findIndex((e) => e.tag === tag);
  assert.ok(cut > 0, `migration ${tag} exists`);
  const dir = await mkdtemp(path.join(tmpdir(), "ooohm-migrations-"));
  await mkdir(path.join(dir, "meta"));
  const entries = journal.entries.slice(0, cut);
  await writeFile(path.join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const { tag: earlier } of entries) {
    await copyFile(path.join(MIGRATIONS_FOLDER, `${earlier}.sql`), path.join(dir, `${earlier}.sql`));
  }
  return dir;
}

describe("migration 0004: per-year request days", { skip }, () => {
  let t: TestDatabase;
  let earlier: string;
  before(async () => {
    earlier = await migrationsBefore("0004_m3_leave_request_days");
    t = await createTestDatabase({ migrationsFolder: earlier });
  });
  after(async () => {
    await t?.drop();
    if (earlier) await rm(earlier, { recursive: true, force: true });
  });

  test("backfills every existing request, splitting ones over New Year, and the rows always add up to its days", async () => {
    const [company] = await t.db.insert(schema.companies).values({ name: "Backfill Co" }).returning();
    const userId = randomUUID();
    await t.db.insert(schema.user).values({ id: userId, name: "Ana", email: `ana-${userId.slice(0, 8)}@example.com`, companyId: company.id });
    const [type] = await t.db.insert(schema.leaveTypes).values({ companyId: company.id, code: "PTO", name: "PTO" }).returning();
    await t.db.insert(schema.holidays).values([
      { companyId: company.id, date: "2027-01-01", name: "New Year" },
      // Added after the second request was submitted: the stored total (3) wins.
      { companyId: company.id, date: "2025-12-31", name: "Added later" },
    ]);

    const insert = async (startDate: string, endDate: string, days: number, dayPortion: "full" | "am" = "full", status: "approved" | "cancelled" = "approved") => {
      const [row] = await t.db
        .insert(schema.leaveRequests)
        .values({ companyId: company.id, userId, leaveTypeId: type.id, startDate, endDate, days, dayPortion, status })
        .returning();
      return row.id;
    };
    const inYear = await insert("2026-11-02", "2026-11-06", 5);
    const half = await insert("2026-11-09", "2026-11-09", 0.5, "am", "cancelled");
    // Tue Dec 30 2025 to Fri Jan 2 2026 was 4 days when submitted. Counted today, Dec 31 is a
    // holiday, so 2025 gets Dec 30 only (1) and 2026 the rest of the stored total (3).
    const overNewYear = await insert("2025-12-30", "2026-01-02", 4);
    // Thu Dec 31 2026 to Mon Jan 4 2027: Dec 31 (2026), Jan 4 (2027); Jan 1 is a holiday.
    const second = await insert("2026-12-31", "2027-01-04", 2);
    // Sat Dec 26 to Fri Jan 1 2027: only Dec 28-31 cost anything (Jan 1 is a holiday), all in 2026.
    const allInFirst = await insert("2026-12-26", "2027-01-01", 4);

    await t.migrate();

    const rows = await t.db.select().from(schema.leaveRequestDays).orderBy(asc(schema.leaveRequestDays.year));
    const of = (id: string) => rows.filter((r) => r.requestId === id).map((r) => [r.year, r.days]);
    assert.deepEqual(of(inYear), [[2026, 5]]);
    assert.deepEqual(of(half), [[2026, 0.5]]);
    assert.deepEqual(of(overNewYear), [[2025, 1], [2026, 3]]);
    assert.deepEqual(of(second), [[2026, 1], [2027, 1]]);
    assert.deepEqual(of(allInFirst), [[2026, 4]]);

    const requests = await t.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.userId, userId));
    for (const r of requests) {
      assert.equal(of(r.id).reduce((sum, [, days]) => sum + days, 0), r.days, `request ${r.startDate}..${r.endDate}`);
    }
  });
});

describe("migration 0007: audit rows name their person", { skip }, () => {
  let t: TestDatabase;
  let earlier: string;
  before(async () => {
    earlier = await migrationsBefore("0007_m5_admin_audit");
    t = await createTestDatabase({ migrationsFolder: earlier });
  });
  after(async () => {
    await t?.drop();
    if (earlier) await rm(earlier, { recursive: true, force: true });
  });

  test("backfills subject_user_id from the leave request, allowance or feed each row audits", async () => {
    // Raw SQL: the app's schema already has the column this migration adds.
    const sql = t.query;
    const [{ id: companyId }] = await sql`insert into companies (name) values ('Backfill Co') returning id`;
    const ana = randomUUID();
    const ben = randomUUID();
    for (const id of [ana, ben]) {
      await sql`insert into "user" (id, name, email, company_id) values (${id}, 'x', ${`${id}@example.com`}, ${companyId})`;
    }
    const [{ id: typeId }] = await sql`insert into leave_types (company_id, code, name) values (${companyId}, 'PTO', 'PTO') returning id`;
    const [{ id: requestId }] = await sql`
      insert into leave_requests (company_id, user_id, leave_type_id, start_date, end_date, days)
      values (${companyId}, ${ana}, ${typeId}, '2026-11-02', '2026-11-02', 1) returning id`;
    const [{ id: allowanceId }] = await sql`
      insert into allowances (user_id, leave_type_id, year, days) values (${ben}, ${typeId}, 2026, 10) returning id`;
    const [{ id: feedId }] = await sql`
      insert into calendar_feed_tokens (company_id, user_id, kind, token_hash)
      values (${companyId}, ${ben}, 'team', ${"a".repeat(64)}) returning id`;
    const audit = async (entityType: string, entityId: string) => {
      const [{ id }] = await sql`
        insert into audit_log (company_id, actor_id, action, entity_type, entity_id)
        values (${companyId}, ${ana}, 'x', ${entityType}, ${entityId}) returning id`;
      return id as string;
    };
    const rows = {
      request: await audit("leave_request", requestId as string),
      allowance: await audit("allowance", allowanceId as string),
      feed: await audit("calendar_feed", feedId as string),
      gone: await audit("leave_request", randomUUID()),
    };

    await t.migrate();

    const subjects = new Map(
      (await t.db.select({ id: schema.auditLog.id, subject: schema.auditLog.subjectUserId }).from(schema.auditLog)).map((r) => [r.id, r.subject]),
    );
    assert.equal(subjects.get(rows.request), ana);
    assert.equal(subjects.get(rows.allowance), ben);
    assert.equal(subjects.get(rows.feed), ben);
    assert.equal(subjects.get(rows.gone), null, "an entity that no longer exists names nobody");
  });
});

describe("migration 0010: every audit row says who or what made it", { skip }, () => {
  let t: TestDatabase;
  let earlier: string;
  before(async () => {
    earlier = await migrationsBefore("0010_m6_change_source");
    t = await createTestDatabase({ migrationsFolder: earlier });
  });
  after(async () => {
    await t?.drop();
    if (earlier) await rm(earlier, { recursive: true, force: true });
  });

  test("backfills a person's rows as theirs, the rollover's and a sync's by process, and the rest as unknown", async () => {
    // Raw SQL: the app's schema already has the columns this migration adds.
    const sql = t.query;
    const [{ id: companyId }] = await sql`insert into companies (name) values ('Backfill Co') returning id`;
    const boss = randomUUID();
    await sql`insert into "user" (id, name, email, company_id, role) values (${boss}, 'Boss', ${`${boss}@example.com`}, ${companyId}, 'admin')`;
    const audit = async (actorId: string | null, action: string, after: object) => {
      const [{ id }] = await sql`
        insert into audit_log (company_id, actor_id, action, entity_type, entity_id, after)
        values (${companyId}, ${actorId}, ${action}, 'x', ${randomUUID()}, ${JSON.stringify(after)}::jsonb) returning id`;
      return id as string;
    };
    const rows = {
      edit: await audit(boss, "holiday.created", { name: "x" }),
      carried: await audit(null, "allowance.carried_over", { days: 1 }),
      created: await audit(null, "allowance.created", { days: 1 }),
      // What the inbound sync wrote before this migration: a marker in the audit row.
      scheduledUser: await audit(null, "user.created", { name: "N", source: "adapter:fakehr" }),
      syncNowUser: await audit(boss, "user.updated", { name: "N", source: "adapter:fakehr" }),
      scheduledAllowance: await audit(null, "allowance.synced", { days: 3, reason: "Synced from adapter:fakehr" }),
      syncNowAllowance: await audit(boss, "allowance.synced", { days: 3, reason: "Synced from adapter:fakehr" }),
      untraceable: await audit(null, "holiday.created", { name: "y" }),
    };

    await t.migrate();

    const stored = new Map(
      (await t.db.select().from(schema.auditLog)).map((r) => [r.id, [r.actorKind, r.actorId, r.actorVia, r.actorProcess]]),
    );
    assert.deepEqual(stored.get(rows.edit), ["user", boss, null, null]);
    assert.deepEqual(stored.get(rows.carried), ["system", null, null, "year_rollover"]);
    assert.deepEqual(stored.get(rows.created), ["system", null, null, "year_rollover"]);
    assert.deepEqual(stored.get(rows.scheduledUser), ["system", null, null, "adapter_sync:fakehr"]);
    assert.deepEqual(stored.get(rows.syncNowUser), ["user", boss, "adapter_sync:fakehr", null]);
    assert.deepEqual(stored.get(rows.scheduledAllowance), ["system", null, null, "adapter_sync:fakehr"]);
    assert.deepEqual(stored.get(rows.syncNowAllowance), ["user", boss, "adapter_sync:fakehr", null]);
    assert.deepEqual(stored.get(rows.untraceable), ["system", null, null, "unknown"]);

    // The checks hold from now on: a system row names a process, and nobody...
    await assert.rejects(sql`insert into audit_log (company_id, actor_kind, action, entity_type, entity_id) values (${companyId}, 'system', 'x', 'x', 'x')`, (err: unknown) => violatedConstraint(err) === "audit_log_actor_shape");
    await assert.rejects(
      sql`insert into audit_log (company_id, actor_kind, actor_id, actor_process, action, entity_type, entity_id) values (${companyId}, 'system', ${boss}, 'year_rollover', 'x', 'x', 'x')`,
      (err: unknown) => violatedConstraint(err) === "audit_log_actor_shape",
    );
    await assert.rejects(sql`insert into audit_log (company_id, actor_kind, action, entity_type, entity_id) values (${companyId}, 'robot', 'x', 'x', 'x')`, (err: unknown) => violatedConstraint(err) === "audit_log_actor_kind_known");
    // ...and deleting a person (OOOhm never does; the foreign key allows it) keeps their rows a person's.
    await sql`delete from "user" where id = ${boss}`;
    assert.deepEqual(
      (await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.id, rows.syncNowUser))).map((r) => [r.actorKind, r.actorId, r.actorVia]),
      [["user", null, "adapter_sync:fakehr"]],
    );
  });
});
