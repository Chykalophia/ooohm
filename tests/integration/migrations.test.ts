import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as schema from "@/db/schema";
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

    await migrate(t.db, { migrationsFolder: MIGRATIONS_FOLDER });

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
