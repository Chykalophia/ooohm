/**
 * Demo company for the marketing site's recordings: a small studio with a manager,
 * eight people, US holidays and a believable spread of requests around "today".
 * Run after `pnpm db:migrate && pnpm db:seed` with SEED_ADMIN_EMAIL=maya@example.com.
 * Writes rows directly (no audit trail), so never point it at a real database.
 *
 *   pnpm tsx --env-file=.env site/demo/demo-data.mts
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { resolveDatabaseConfig } from "../../src/db/config";
import { openDatabase } from "../../src/db/connect";
import * as s from "../../src/db/schema";
import { nonEmptyEnv } from "../../src/lib/integration-env";

// Embedded PGlite, or Postgres on this machine; never anything else.
function isLocal(url: string | undefined): boolean {
  if (!url || url.startsWith("pglite:") || process.env.OOOHM_DB === "embedded") return true;
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}
if (!isLocal(process.env.DATABASE_URL)) throw new Error("demo-data only runs against a local database.");

const handle = await openDatabase(resolveDatabaseConfig(nonEmptyEnv(process.env)), { purpose: "demo data", max: 1 });
const { db } = handle;
const YEAR = 2026;

const companies = await db.select().from(s.companies).limit(2);
if (companies.length !== 1) {
  throw new Error(companies.length ? "More than one company exists; the demo needs a database of its own." : "No company yet. Run `pnpm db:seed` with SEED_ADMIN_EMAIL=maya@example.com first.");
}
const [company] = companies;
await db.update(s.companies).set({ requestStyle: "sentence" }).where(eq(s.companies.id, company.id));
const types = Object.fromEntries((await db.select().from(s.leaveTypes).where(eq(s.leaveTypes.companyId, company.id))).map((t) => [t.code, t]));
const [maya] = await db.select().from(s.user).where(eq(s.user.email, "maya@example.com"));
if (!maya) throw new Error("maya@example.com not found. Run `pnpm db:seed` with SEED_ADMIN_EMAIL=maya@example.com first.");

const depts: Record<string, string> = {};
for (const name of ["Design", "Engineering", "Sales"]) {
  const [d] = await db.insert(s.departments).values({ companyId: company.id, name }).onConflictDoNothing().returning();
  depts[name] = d?.id ?? (await db.select().from(s.departments).where(and(eq(s.departments.companyId, company.id), eq(s.departments.name, name))))[0].id;
}
await db.update(s.user).set({ departmentId: depts.Design }).where(eq(s.user.id, maya.id));

const people = [
  ["Lena Park", "Design"], ["Jonas Berg", "Sales"], ["Aisha Khan", "Design"], ["Tomás Silva", "Engineering"],
  ["Priya Nair", "Engineering"], ["Sam Okafor", "Sales"], ["Noor Haddad", "Engineering"], ["Eli Brooks", "Design"],
] as const;
const ids: Record<string, string> = { "Maya Chen": maya.id };
for (const [name, dept] of people) {
  const email = `${name.split(" ")[0].toLowerCase().normalize("NFD").replace(/[^a-z]/g, "")}@example.com`;
  const [existing] = await db.select().from(s.user).where(eq(s.user.email, email));
  ids[name] = existing?.id ?? (await db.insert(s.user).values({
    id: randomUUID(), name, email, emailVerified: true, companyId: company.id, departmentId: depts[dept], managerId: maya.id, role: "employee",
  }).returning())[0].id;
}

for (const id of Object.values(ids)) {
  for (const t of Object.values(types)) {
    if (t.defaultAllowanceDays === null) continue;
    await db.insert(s.allowances).values({ userId: id, leaveTypeId: t.id, year: YEAR, days: t.defaultAllowanceDays }).onConflictDoNothing();
  }
}

const holidays: [string, string][] = [
  ["2026-01-01", "New Year's Day"], ["2026-05-25", "Memorial Day"], ["2026-07-03", "Independence Day (observed)"],
  ["2026-09-07", "Labor Day"], ["2026-11-26", "Thanksgiving"], ["2026-11-27", "Day after Thanksgiving"],
  ["2026-12-24", "Christmas Eve"], ["2026-12-25", "Christmas Day"],
];
for (const [date, name] of holidays) await db.insert(s.holidays).values({ companyId: company.id, date, name }).onConflictDoNothing();

type Req = [who: string, type: string, start: string, end: string, days: number, status: "pending" | "approved" | "rejected" | "cancelled", note?: string, portion?: "full" | "am" | "pm"];
const reqs: Req[] = [
  ["Maya Chen", "PTO", "2026-11-16", "2026-11-18", 3, "approved", "Family trip"],
  ["Maya Chen", "PTO", "2026-08-03", "2026-08-07", 5, "approved", "Lake house"],
  ["Maya Chen", "SICK", "2026-03-12", "2026-03-12", 1, "approved"],
  ["Maya Chen", "PTO", "2026-12-07", "2026-12-08", 2, "approved"],
  ["Lena Park", "PTO", "2026-11-23", "2026-11-25", 3, "pending", "Thanksgiving with family"],
  ["Aisha Khan", "PTO", "2026-11-23", "2026-11-25", 3, "approved", "Visiting my sister"],
  ["Aisha Khan", "PTO", "2026-12-21", "2026-12-23", 3, "approved"],
  ["Jonas Berg", "PTO", "2026-12-14", "2026-12-18", 5, "pending"],
  ["Tomás Silva", "PTO", "2026-11-04", "2026-11-06", 3, "approved", "Lisbon"],
  ["Priya Nair", "SICK", "2026-11-03", "2026-11-03", 1, "approved"],
  ["Sam Okafor", "PTO", "2026-11-09", "2026-11-13", 5, "approved"],
  ["Noor Haddad", "EMERGENCY", "2026-11-05", "2026-11-05", 0.5, "approved", undefined, "pm"],
  ["Eli Brooks", "PTO", "2026-11-12", "2026-11-13", 2, "pending", "Long weekend"],
  ["Priya Nair", "PTO", "2026-11-30", "2026-12-04", 5, "approved"],
  ["Lena Park", "PTO", "2026-10-19", "2026-10-21", 3, "approved"],
  ["Jonas Berg", "SICK", "2026-10-27", "2026-10-27", 1, "approved"],
];
// Every run starts the story over: the recordings change requests as they go. One
// transaction, so a failure leaves the previous requests in place rather than none.
await db.transaction(async (tx) => {
  await tx.delete(s.leaveRequests).where(eq(s.leaveRequests.companyId, company.id));
  for (const [who, code, start, end, days, status, note, portion] of reqs) {
    const decided = status === "approved" || status === "rejected";
    const [r] = await tx.insert(s.leaveRequests).values({
      companyId: company.id, userId: ids[who], leaveTypeId: types[code].id, startDate: start, endDate: end, days,
      dayPortion: portion ?? "full", note, status, approverId: maya.id, decidedAt: decided ? new Date("2026-10-30T15:00:00Z") : null,
    }).returning();
    await tx.insert(s.leaveRequestDays).values({ requestId: r.id, year: YEAR, days });
  }
});

await handle.close();
console.log("Demo data ready.");
