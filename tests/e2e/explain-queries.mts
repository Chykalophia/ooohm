/**
 * Query-plan check for the read paths people hit most: seeds two companies of 50 people
 * with three years of leave (about 1,800 requests each, plus allowances, holidays, audit
 * rows and outbox events), runs the real services for the dashboard, calendars, approvals,
 * admin screens and REST API, and prints every SQL statement they sent with its
 * `EXPLAIN (ANALYZE, BUFFERS)` plan. Statements that sequentially scan a large table are
 * flagged.
 *
 *   DATABASE_URL=postgres://.../empty_db tsx --conditions=react-server tests/e2e/explain-queries.mts [--plans]
 *
 * Point it at an empty, migrated database (`pnpm db:migrate`): it writes test data.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../src/db/schema";
import type { Actor } from "../../src/domain/actor";
import { byUser } from "../../src/domain/change-source";
import { eachDate, isoWeekday } from "../../src/domain/calendar-date";
import { STRICT_TARGET_POLICY } from "../../src/domain/webhook-target";
import { unavailableSecretBox } from "../../src/lib/integration-crypto";
import type { ServiceContext } from "../../src/server/context";
import { createAdapterRegistry } from "../../src/server/integrations/adapter";
import { getPersonDetail, listPeople } from "../../src/server/services/admin-people";
import { listBalancesForApi, listEventsForApi, listLeaveRequestsForApi, listUsersForApi } from "../../src/server/services/api-v1";
import { getApprovalNav, listApprovalInbox } from "../../src/server/services/approvals";
import { getAuditLog } from "../../src/server/services/audit-log";
import { getMonthCalendar, getTeamCalendar } from "../../src/server/services/calendar";
import { getDashboard } from "../../src/server/services/leave-requests";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const showPlans = process.argv.includes("--plans");

const captured: { query: string; params: unknown[] }[] = [];
let capturing = false;
const client = postgres(url, {
  max: 4,
  onnotice: () => {},
  debug: (_conn, query, params) => {
    if (capturing) captured.push({ query, params: params as unknown[] });
  },
});
const db = drizzle(client, { schema, casing: "snake_case" });
const ctx: ServiceContext = {
  db,
  mailer: async () => {},
  defer: () => {},
  appUrl: "https://ooohm.test",
  now: () => new Date("2026-11-01T15:00:00Z"),
  issueSignInLink: async () => "",
  secrets: unavailableSecretBox("not used"),
  webhookTargets: STRICT_TARGET_POLICY,
  adapters: createAdapterRegistry(),
};

const YEARS = [2024, 2025, 2026];
const PEOPLE = 50;

async function seedCompany(name: string) {
  const [company] = await db.insert(schema.companies).values({ name }).returning();
  const types = await db
    .insert(schema.leaveTypes)
    .values(["PTO", "SICK", "EMERGENCY", "BONUS"].map((code, i) => ({ companyId: company.id, code, name: code, sortOrder: i, defaultAllowanceDays: code === "PTO" ? 20 : null })))
    .returning();
  const departments = await db
    .insert(schema.departments)
    .values(["Engineering", "Operations", "Sales"].map((n) => ({ companyId: company.id, name: n })))
    .returning();
  await db.insert(schema.holidays).values(YEARS.flatMap((y) => [`${y}-01-01`, `${y}-07-03`, `${y}-12-25`].map((date) => ({ companyId: company.id, date, name: "Holiday" }))));
  const people = Array.from({ length: PEOPLE }, (_, i) => ({
    id: randomUUID(),
    companyId: company.id,
    email: `p${i}-${company.id.slice(0, 8)}@example.com`,
    name: `Person ${i}`,
    role: (i === 0 ? "admin" : i < 5 ? "manager" : "employee") as Actor["role"],
    departmentId: departments[i % 3].id,
    createdAt: new Date("2023-01-02T00:00:00Z"),
  }));
  await db.insert(schema.user).values(people);
  for (const p of people.slice(5)) {
    await db.update(schema.user).set({ managerId: people[1 + (people.indexOf(p) % 4)].id }).where(eq(schema.user.id, p.id));
  }
  await db.insert(schema.allowances).values(people.flatMap((p) => YEARS.map((year) => ({ userId: p.id, leaveTypeId: types[0].id, year, days: 20 }))));

  const requests: (typeof schema.leaveRequests.$inferInsert & { id: string })[] = [];
  const days: (typeof schema.leaveRequestDays.$inferInsert)[] = [];
  const statuses = ["approved", "approved", "approved", "pending", "rejected", "cancelled"] as const;
  for (const [pi, p] of people.entries()) {
    for (const year of YEARS) {
      for (let k = 0; k < 12; k++) {
        const start = `${year}-${String(k + 1).padStart(2, "0")}-${String(3 + (pi % 20)).padStart(2, "0")}`;
        const end = `${year}-${String(k + 1).padStart(2, "0")}-${String(4 + (pi % 20)).padStart(2, "0")}`;
        const cost = eachDate(start, end).filter((d) => isoWeekday(d) <= 5).length || 1;
        const id = randomUUID();
        const status = statuses[(pi + k) % statuses.length];
        requests.push({
          id,
          companyId: company.id,
          userId: p.id,
          leaveTypeId: types[k % 4 === 3 ? 1 : 0].id,
          startDate: start,
          endDate: end,
          days: cost,
          status,
          approverId: people[1 + (pi % 4)].id,
          decidedAt: status === "pending" ? null : new Date(`${start}T09:00:00Z`),
        });
        days.push({ requestId: id, year, days: cost });
      }
    }
  }
  for (let i = 0; i < requests.length; i += 500) {
    await db.insert(schema.leaveRequests).values(requests.slice(i, i + 500));
    await db.insert(schema.leaveRequestDays).values(days.slice(i, i + 500));
  }
  const audit = requests.map((r) => ({
    companyId: company.id,
    actorKind: "user",
    actorId: r.userId,
    action: "leave_request.requested",
    entityType: "leave_request",
    entityId: r.id,
    subjectUserId: r.userId,
    before: null,
    after: { status: r.status },
  }));
  for (let i = 0; i < audit.length; i += 500) {
    await db.insert(schema.auditLog).values(audit.slice(i, i + 500));
    await db.insert(schema.eventsOutbox).values(audit.slice(i, i + 500).map((a) => ({ companyId: company.id, type: "leave.requested", payload: { requestId: a.entityId } })));
  }
  const actor = (p: (typeof people)[number]): Actor => ({ id: p.id, companyId: company.id, role: p.role, canSelfApprove: false, source: byUser(p.id) });
  return { companyId: company.id, admin: actor(people[0]), manager: actor(people[1]), employee: actor(people[10]) };
}

const BIG_TABLES = ["leave_requests", "leave_request_days", "audit_log", "events_outbox", "allowances"];

async function explain(label: string, work: () => Promise<unknown>) {
  captured.length = 0;
  capturing = true;
  await work();
  capturing = false;
  const statements = captured.filter((c) => !/^(begin|commit|rollback|set)/i.test(c.query.trim()));
  console.log(`\n### ${label}: ${statements.length} statement(s)`);
  for (const { query, params } of statements) {
    const rows = await client.unsafe(`explain (analyze, buffers, format text) ${query}`, params as never[]);
    const plan = rows.map((r) => r["QUERY PLAN"] as string);
    const exec = plan.find((l) => l.startsWith("Execution Time"))?.replace("Execution Time: ", "") ?? "?";
    const seq = plan.filter((l) => BIG_TABLES.some((t) => new RegExp(`Seq Scan on ${t}\\b`).test(l)));
    console.log(`- ${exec.padStart(10)}  ${query.replace(/\s+/g, " ").slice(0, 110)}`);
    for (const s of seq) console.log(`    !! ${s.trim()}`);
    if (showPlans) console.log(plan.map((l) => `      ${l}`).join("\n"));
  }
}

try {
  const [company] = await db.select({ id: schema.companies.id }).from(schema.companies).limit(1);
  if (company) throw new Error("The database already has a company; point DATABASE_URL at an empty, migrated database.");
  await seedCompany("Noise Co");
  const co = await seedCompany("Perf Co");
  await client.unsafe("analyze");
  const counts = await client.unsafe("select (select count(*) from leave_requests) as requests, (select count(*) from audit_log) as audit, (select count(*) from \"user\") as people");
  console.log(`Seeded: ${JSON.stringify(counts[0])}`);

  await explain("dashboard (employee)", () => getDashboard(ctx, co.employee));
  await explain("calendar month (employee)", () => getMonthCalendar(ctx, co.employee, "2026-03"));
  await explain("team calendar (everyone)", () => getTeamCalendar(ctx, co.employee, { month: "2026-03" }));
  await explain("approvals inbox (admin)", () => listApprovalInbox(ctx, co.admin));
  await explain("approvals inbox (manager)", () => listApprovalInbox(ctx, co.manager));
  await explain("header approvals nav (manager)", () => getApprovalNav(ctx, co.manager));
  await explain("admin people list", () => listPeople(ctx, co.admin, { status: "active" }));
  await explain("admin person detail", () => getPersonDetail(ctx, co.admin, co.employee.id, 2026));
  await explain("audit log, first page", () => getAuditLog(ctx, co.admin, {}));
  await explain("audit log, one person", () => getAuditLog(ctx, co.admin, { subjectUserId: co.employee.id }));
  // A search is not read in index order (several ids on three columns): see listAuditPage.
  await explain("audit log, search", () => getAuditLog(ctx, co.admin, { query: "approved" }));
  const api = { keyId: randomUUID(), companyId: co.companyId, scopes: ["read" as const] };
  await explain("API /users", () => listUsersForApi(ctx, api, { limit: 100 }));
  await explain("API /leave-requests from 2026-01-01", () => listLeaveRequestsForApi(ctx, api, { from: "2026-01-01", limit: 100 }));
  await explain("API /leave-requests one person", () => listLeaveRequestsForApi(ctx, api, { userId: co.employee.id, limit: 100 }));
  await explain("API /balances", () => listBalancesForApi(ctx, api, { year: 2026 }));
  await explain("API /events", () => listEventsForApi(ctx, api, { limit: 100 }));
} finally {
  await client.end();
}
