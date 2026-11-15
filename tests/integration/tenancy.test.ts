/**
 * Tenant isolation (ADR-0004): two companies in one database. Every public query and use
 * case, every executor-taking read and step, and every `/api/v1` route is called by
 * company Alpha's people, key or id with Bravo's ids. After each call:
 *
 * - Bravo's rows (every table, by company or through its people and requests) are exactly
 *   as seeded: nothing of Bravo was changed or deleted;
 * - what came back, and every email or sign-in link the call sent, holds nothing of
 *   Bravo's (no id, email or name);
 * - none of Alpha's rows now points at anything of Bravo's.
 *
 * Which exports must have a case is decided by tests/support/tenancy-coverage.ts, which
 * tests/architecture/tenancy-coverage.test.ts keeps in step with the code; the last test
 * here checks the cases match that list.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { eq, getTableColumns, inArray, is, type SQL } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import type { Database, Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { isServiceResult, unwrap } from "@/shared/lib/result";
import { createRateLimiter } from "@/lib/rate-limit";
import type { ServiceContext } from "@/server/context";
import * as approvals from "@/modules/approvals";
import * as audit from "@/modules/audit";
import * as balances from "@/modules/balances";
import * as calendar from "@/modules/calendar";
import * as holidays from "@/modules/holidays";
import * as integrations from "@/modules/integrations";
import * as leave from "@/modules/leave";
import * as notifications from "@/modules/notifications";
import * as organisation from "@/modules/organisation";
import * as reports from "@/modules/reports";
import * as people from "@/modules/people";
import { findMemberStanding } from "@/shared/lib/db/admin-standing";
import * as members from "@/shared/lib/db/members";
import * as companySettings from "@/server/services/company-settings";
import * as departmentManager from "@/server/services/department-manager";
import { handleApiRequest, parseQuery, REQUESTS_PER_KEY_PER_MINUTE, UNAUTHORIZED_PER_CLIENT_PER_MINUTE } from "@/app/api/v1/_lib/handler";
import { balancesQuery, eventsQuery, holidaysQuery, leaveRequestsQuery, usersQuery } from "@/app/api/v1/_lib/query";
import { pngImage } from "../support/images";
import { API_ROUTES_COVERED, COVERED } from "../support/tenancy-coverage";
import { addLeaveType, seedCompany, setAllowance } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestContext, type TestDatabase } from "./harness";

type Person = Actor & { email: string; name: string };

interface Tenant {
  label: string;
  /** In every name this company gives a person, department, level, leave type, holiday or email. */
  token: string;
  companyId: string;
  ctx: TestContext;
  admin: Person;
  boss: Person;
  emp: Person;
  pal: Person;
  pto: string;
  vac: string;
  department: string;
  level: string;
  rule: string;
  holiday: string;
  pending: string;
  approved: string;
  apiKey: { key: string; id: string };
  endpoint: string;
  delivery: string;
  feeds: { team: string; personal: string };
}

const BRAVO_ALLOWANCE = 17.5;

async function seedTenant(t: TestDatabase, label: string, holidayDate: string): Promise<Tenant> {
  const token = `${label.toUpperCase()}${Math.random().toString(36).slice(2, 8)}`;
  const co = await seedCompany(t.db, {
    admin: { role: "admin", createdAt: "2026-01-01T00:00:00Z" },
    boss: { role: "manager", managerKey: "admin" },
    emp: { managerKey: "boss" },
    pal: { managerKey: "boss" },
  });
  const ctx = createTestContext(t.db, { webhookTargets: { allowInsecure: true, allowPrivate: true } });
  await t.db.update(schema.companies).set({ name: `${token} Inc` }).where(eq(schema.companies.id, co.companyId));
  const named: Record<string, Person> = {};
  for (const [key, p] of Object.entries(co.people)) {
    const name = `${token} ${key}`;
    await t.db.update(schema.user).set({ name }).where(eq(schema.user.id, p.id));
    named[key] = { ...p, name };
  }
  const { admin, boss, emp, pal } = named;
  await t.db.update(schema.leaveTypes).set({ name: `${token} PTO` }).where(eq(schema.leaveTypes.id, co.pto));
  const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 20 });
  await t.db.update(schema.leaveTypes).set({ name: `${token} Vacation` }).where(eq(schema.leaveTypes.id, vac));

  const department = unwrap(await organisation.createDepartment(ctx, admin, `${token} Ops`));
  const level = unwrap(await organisation.createLevel(ctx, admin, `${token} Senior`));
  await t.db.update(schema.user).set({ departmentId: department.id, levelId: level.id }).where(inArray(schema.user.id, [emp.id, pal.id, boss.id]));
  unwrap(await departmentManager.setDepartmentManager(ctx, admin, department.id, boss.id));
  await setAllowance(t.db, { userId: emp.id, leaveTypeId: vac, year: 2026, days: label === "bravo" ? BRAVO_ALLOWANCE : 20 });
  const rule = unwrap(await balances.setAllowanceRule(ctx, admin, { leaveTypeId: vac, departmentId: department.id, levelId: null, days: 22 }));
  const holiday = unwrap(await holidays.addHoliday(ctx, admin, { date: holidayDate, name: `${token} Eve` }));
  const apiKey = unwrap(await integrations.createApiKey(ctx, admin, { name: `${token} key` }));
  const endpoint = unwrap(
    await integrations.createWebhookEndpoint(ctx, admin, { url: `https://hooks.example.com/${label}`, description: `${token} hook`, eventTypes: ["leave.requested", "leave.approved"] }),
  );

  const pending = unwrap(await leave.submitLeaveRequest(ctx, emp, { leaveTypeId: vac, startDate: "2026-12-01", dayPortion: "full", note: `${token} note` }));
  const asked = unwrap(await leave.submitLeaveRequest(ctx, emp, { leaveTypeId: vac, startDate: "2026-11-16", dayPortion: "full" }));
  unwrap(await approvals.decideLeaveRequest(ctx, boss, { requestId: asked.id, decision: "approve", reason: `${token} enjoy` }));
  await leave.submitLeaveRequest(ctx, pal, { leaveTypeId: co.pto, startDate: "2026-12-08", dayPortion: "full" });
  const personal = unwrap(await calendar.issueCalendarFeed(ctx, emp, "personal"));
  const team = unwrap(await calendar.issueCalendarFeed(ctx, admin, "team"));
  unwrap(await notifications.saveEmailCopy(ctx, admin, "leave.requested", { subject: `${token} subject {{requesterName}}`, message: `${token} message` }));
  unwrap(await organisation.updateCompanyLogo(ctx, admin, pngImage(64, 64, label === "bravo" ? [200, 10, 10] : [10, 200, 10])));
  await ctx.settle();

  await integrations.dispatchOutboxBatch(ctx, {});
  const [delivery] = await t.db
    .select({ id: schema.webhookDeliveries.id })
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.endpointId, endpoint.endpoint.id));
  assert.ok(delivery, "the seed delivers at least one event to the endpoint");

  return {
    label,
    token,
    companyId: co.companyId,
    ctx,
    admin,
    boss,
    emp,
    pal,
    pto: co.pto,
    vac,
    department: department.id,
    level: level.id,
    rule: rule.id,
    holiday: holiday.holiday.id,
    pending: pending.id,
    approved: asked.id,
    apiKey: { key: apiKey.key, id: apiKey.apiKey.id },
    endpoint: endpoint.endpoint.id,
    delivery: delivery.id,
    feeds: { team: feedToken(team.url), personal: feedToken(personal.url) },
  };
}

/** The token in a feed URL (`…/api/ics/<token>.ics`). */
function feedToken(url: string): string {
  const match = /\/api\/ics\/([^/.?]+)\.ics/.exec(url);
  assert.ok(match, `a feed URL: ${url}`);
  return match[1];
}

// ---------------------------------------------------------------------------------------
// What belongs to a company, and whether anything else mentions it.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every row of a company, by table: rows with its company id, and rows of its people and requests. */
async function snapshot(db: Database, companyId: string): Promise<Record<string, string[]>> {
  const userIds = (await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.companyId, companyId))).map((r) => r.id);
  const requestIds = (await db.select({ id: schema.leaveRequests.id }).from(schema.leaveRequests).where(eq(schema.leaveRequests.companyId, companyId))).map(
    (r) => r.id,
  );
  const out: Record<string, string[]> = {};
  for (const [name, table] of Object.entries(schema)) {
    if (!is(table, PgTable)) continue;
    const cols = getTableColumns(table) as Record<string, Parameters<typeof eq>[0]>;
    let where: SQL | undefined;
    if (table === schema.companies) where = eq(schema.companies.id, companyId);
    else if ("companyId" in cols) where = eq(cols.companyId, companyId);
    else if ("requestId" in cols) where = requestIds.length ? inArray(cols.requestId, requestIds) : undefined;
    else if ("userId" in cols) where = userIds.length ? inArray(cols.userId, userIds) : undefined;
    if (!where) continue;
    const rows = await db.select().from(table).where(where);
    out[name] = rows.map((r) => JSON.stringify(r)).sort();
  }
  return out;
}

/** The strings that identify a company's rows: ids, emails, and anything carrying its token. */
function markersOf(rows: Record<string, string[]>, token: string): Set<string> {
  const markers = new Set<string>([token]);
  for (const list of Object.values(rows)) {
    for (const json of list) {
      for (const value of Object.values(JSON.parse(json) as Record<string, unknown>)) {
        if (typeof value !== "string") continue;
        if (ID.test(value) || value.includes("@")) markers.add(value);
      }
    }
  }
  return markers;
}

/** JSON of anything a call returns, with Maps, Sets, binary data and functions spelled out. */
function serialize(value: unknown): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof Map) return { map: [...v.entries()] };
    if (v instanceof Set) return { set: [...v] };
    if (v instanceof Uint8Array) return `bytes:${v.length}`;
    if (typeof v === "function") return "[function]";
    if (typeof v === "bigint") return v.toString();
    return v;
  });
}

function leaks(text: string, markers: Set<string>, allowed: readonly string[] = []): string[] {
  return [...markers].filter((m) => !allowed.includes(m) && text.includes(m));
}

// ---------------------------------------------------------------------------------------
// The cases.

interface World {
  t: TestDatabase;
  a: Tenant;
  b: Tenant;
  /** Alpha's context: every case calls with it. */
  ctx: TestContext;
}

interface Case {
  /** The exports this case calls, as in tests/support/tenancy-coverage.ts. */
  covers: readonly string[];
  name: string;
  /** Returns what the call returned; a thrown error or a failed result counts as refused. */
  run: (w: World) => Promise<unknown>;
  /** Bravo strings the call may echo back because the caller passed them in. */
  echoes?: (w: World) => readonly string[];
  /** A stricter check of what came back (when it did not refuse). */
  check?: (value: unknown, w: World) => void | Promise<void>;
}

/** Runs `work` in a transaction that commits, as a step's caller would. */
const inTx = <T>(w: World, work: (tx: Transaction) => Promise<T>) => w.t.db.transaction(work);

const draft = (leaveTypeId: string, startDate = "2026-12-14") => ({ leaveTypeId, startDate, dayPortion: "full" as const });
const leaveTypeInput = (name: string, code: string) => ({
  name,
  code,
  color: "#7C3AED",
  isPaid: true,
  countsAgainstAllowance: true,
  defaultAllowanceDays: 10,
  carryoverEnabled: false,
  carryoverMaxDays: null,
});
const personInput = (over: Partial<people.PersonInput> = {}): people.PersonInput => ({
  name: "Somebody New",
  departmentId: null,
  managerId: null,
  role: "employee",
  canSelfApprove: false,
  ...over,
});
const emptyMap = (value: unknown) => assert.equal((value as Map<unknown, unknown>).size, 0);
const nothing = (value: unknown) => assert.ok(value === undefined || value === null || (Array.isArray(value) && value.length === 0), `expected nothing, got ${serialize(value)}`);

async function pendingOf(w: World, tenant: Tenant) {
  return approvals.listPendingRequestsOf(w.t.db, tenant.companyId, tenant.emp.id);
}

const CASES: Case[] = [
  // Approvals.
  {
    covers: ["approvals:decideLeaveRequest"],
    name: "an admin cannot decide another company's request",
    run: ({ ctx, a, b }) => approvals.decideLeaveRequest(ctx, a.admin, { requestId: b.pending, decision: "approve" }),
  },
  {
    covers: ["approvals:decideLeaveRequest"],
    name: "an email link's approver cannot decide another company's request",
    run: ({ ctx, a, b }) => approvals.decideLeaveRequest(ctx, a.admin, { requestId: b.pending, decision: "reject", assignedTo: a.admin.id }),
  },
  {
    covers: ["approvals:getApprovalTriage"],
    name: "the Approvals tabs list only the company's requests",
    run: async ({ ctx, a }) => [
      await approvals.getApprovalTriage(ctx, a.admin, { view: "mine" }),
      await approvals.getApprovalTriage(ctx, a.admin, { view: "others" }),
      await approvals.getApprovalTriage(ctx, a.boss, { view: "mine" }),
    ],
  },
  { covers: ["approvals:getApprovalNav"], name: "the approvals badge counts only the company's requests", run: ({ ctx, a }) => approvals.getApprovalNav(ctx, a.admin) },
  {
    covers: ["approvals:approveLinkFor", "approvals:readEmailApproval", "approvals:approveFromEmail"],
    name: "an approve link naming another company's request neither reads nor approves it",
    run: async ({ ctx, a, b }) => {
      const link = approvals.approveLinkFor(ctx, b.pending, a.admin.id);
      assert.ok(link);
      const token = link.slice(link.lastIndexOf("/") + 1);
      return [await approvals.readEmailApproval(ctx, token).catch((e: unknown) => ({ refused: String(e) })), await approvals.approveFromEmail(ctx, token)];
    },
    echoes: ({ b }) => [b.pending],
    check: (value) => {
      const [read, approve] = value as [Record<string, unknown>, unknown];
      assert.ok(!("request" in read) || read.request === null || read.request === undefined, `read: ${serialize(read)}`);
      if (isServiceResult(approve)) assert.equal(approve.ok && (approve.value as { kind?: string }).kind === "approved", false);
    },
  },
  {
    covers: ["approvals:rerouteApprovals"],
    name: "re-routing with another company's request rows leaves them alone",
    run: async (w) => {
      const theirs = await pendingOf(w, w.b);
      assert.ok(theirs.length > 0);
      return inTx(w, (tx) => approvals.rerouteApprovals(w.ctx, tx, w.a.admin, theirs));
    },
    echoes: ({ b }) => [b.pending, b.emp.id, b.boss.id, b.companyId, b.vac, b.emp.email],
  },
  {
    covers: ["approvals:loadApprovalContexts"],
    name: "the routing loader finds no approver in another company",
    run: ({ t, a, b }) =>
      approvals.loadApprovalContexts(t.db, a.companyId, [{ id: b.emp.id, role: "employee", canSelfApprove: false, managerId: b.boss.id, departmentId: b.department }]),
    echoes: ({ b }) => [b.emp.id, b.boss.id, b.department],
    check: (value, { b }) => {
      const context = (value as Map<string, { candidates?: unknown }>).get(b.emp.id);
      assert.ok(!serialize(context).includes(b.boss.email));
    },
  },
  {
    covers: ["approvals:listPendingAssignedTo", "approvals:listPendingRequestsOf", "approvals:listPendingRequestsInDepartment", "approvals:listPendingSelfRouted"],
    name: "pending reads by company never return another company's requests",
    run: async ({ t, a, b }) => [
      await approvals.listPendingAssignedTo(t.db, a.companyId, b.boss.id),
      await approvals.listPendingRequestsOf(t.db, a.companyId, b.emp.id),
      await approvals.listPendingRequestsInDepartment(t.db, a.companyId, b.department),
      await approvals.listPendingSelfRouted(t.db, a.companyId),
    ],
    check: (value) => assert.deepEqual((value as unknown[][]).slice(0, 3), [[], [], []]),
  },

  // Audit.
  {
    covers: ["audit:getAuditLog"],
    name: "the audit log shows only the company's rows, whatever the filter",
    run: async ({ ctx, a, b }) => [
      await audit.getAuditLog(ctx, a.admin, {}),
      await audit.getAuditLog(ctx, a.admin, { actorId: b.admin.id }),
      await audit.getAuditLog(ctx, a.admin, { subjectUserId: b.emp.id }),
    ],
    echoes: ({ b }) => [b.admin.id, b.emp.id],
  },
  {
    covers: ["audit:listAuditEntriesAbout"],
    name: "a person's audit history cannot be read for another company's person",
    run: ({ ctx, a, b }) => audit.listAuditEntriesAbout(ctx, a.admin, b.emp.id, 100),
    check: nothing,
  },
  {
    covers: ["audit:countRecentActions"],
    name: "the rate-limit count sees no other company's actions",
    run: async ({ t, a, b }) => {
      const actions = [...new Set((await t.db.select({ action: schema.auditLog.action }).from(schema.auditLog).where(eq(schema.auditLog.companyId, b.companyId))).map((r) => r.action))];
      return audit.countRecentActions(t.db, { companyId: a.companyId, actorId: b.emp.id, actions }, 60 * 24 * 365);
    },
    check: (value) => assert.equal(value, 0),
  },

  // Balances.
  { covers: ["balances:getBalanceSummary"], name: "a balance summary is the company's own", run: ({ ctx, a }) => balances.getBalanceSummary(ctx, a.emp, 2026) },
  {
    covers: ["balances:previewLeaveRequest"],
    name: "a preview cannot price another company's leave type",
    run: ({ ctx, a, b }) => balances.previewLeaveRequest(ctx, a.emp, draft(b.vac)),
  },
  {
    covers: ["balances:setAllowanceOverride"],
    name: "an allowance cannot be set for another company's person or leave type",
    run: async ({ ctx, a, b }) => [
      await balances.setAllowanceOverride(ctx, a.admin, { userId: b.emp.id, leaveTypeId: a.vac, year: 2026, days: 3, adjustmentDays: 0, reason: "x" }),
      await balances.setAllowanceOverride(ctx, a.admin, { userId: a.emp.id, leaveTypeId: b.vac, year: 2026, days: 3, adjustmentDays: 0, reason: "x" }),
      await balances.setAllowanceOverride(ctx, a.admin, { userId: b.emp.id, leaveTypeId: b.vac, year: 2026, days: 3, adjustmentDays: 0, reason: "x" }),
    ],
  },
  {
    covers: ["balances:setAllowanceRule"],
    name: "an allowance rule cannot name another company's leave type, department or level",
    run: async ({ ctx, a, b }) => [
      await balances.setAllowanceRule(ctx, a.admin, { leaveTypeId: b.vac, departmentId: null, levelId: a.level, days: 5 }),
      await balances.setAllowanceRule(ctx, a.admin, { leaveTypeId: a.vac, departmentId: b.department, levelId: null, days: 5 }),
      await balances.setAllowanceRule(ctx, a.admin, { leaveTypeId: a.vac, departmentId: null, levelId: b.level, days: 5 }),
      await balances.setAllowanceRule(ctx, a.admin, { leaveTypeId: b.vac, departmentId: b.department, levelId: null, days: 5 }),
    ],
  },
  { covers: ["balances:removeAllowanceRule"], name: "another company's allowance rule cannot be removed", run: ({ ctx, a, b }) => balances.removeAllowanceRule(ctx, a.admin, b.rule) },
  {
    covers: ["balances:getAllowanceRulesForm", "balances:listAllowanceRulesForAdmin"],
    name: "allowance rules are read only for the company's leave types",
    run: async ({ ctx, a, b }) => [
      await balances.getAllowanceRulesForm(ctx, a.admin, b.vac),
      await balances.listAllowanceRulesForAdmin(ctx, a.admin, b.vac),
      await balances.getAllowanceRulesForm(ctx, a.admin, a.vac),
      await balances.listAllowanceRulesForAdmin(ctx, a.admin, a.vac),
    ],
  },
  {
    covers: ["balances:loadAllowanceDefaults"],
    name: "allowance defaults apply no other company's rule",
    run: ({ t, a, b }) => balances.loadAllowanceDefaults(t.db, a.companyId, [b.emp.id]),
    check: (value, { b }) => assert.equal((value as balances.AllowanceDefaults)(b.emp.id, { id: b.vac, defaultAllowanceDays: null }), null),
  },
  {
    // loadBalanceInputs, loadBalances and summarizeBalances are exempt (their company id
    // picks the allowance rules only); every use case that reaches them is called here
    // with Bravo's ids, and this pins down the other half: no Bravo balance shows.
    covers: [],
    name: "Bravo's allowance shows through no Alpha balance read",
    run: async ({ ctx, a, b }) => [
      await balances.getBalanceSummary(ctx, a.admin, 2026),
      await people.getPersonDetail(ctx, a.admin, b.emp.id, 2026).catch((e: unknown) => ({ refused: String(e) })),
      await reports.getLeaveReport(ctx, a.admin, { year: 2026 }),
    ],
    check: (value) => assert.ok(!serialize(value).includes(`:${BRAVO_ALLOWANCE}`), serialize(value)),
  },
  {
    covers: ["balances:assessLeaveRequest"],
    name: "assessing a draft refuses another company's leave type",
    run: ({ t, a, b }) => balances.assessLeaveRequest(t.db, { id: a.emp.id, companyId: a.companyId }, draft(b.vac)),
  },
  {
    covers: ["balances:followDefaults"],
    name: "following defaults changes no other company's allowance",
    run: (w) => inTx(w, (tx) => balances.followDefaults(tx, w.a.admin, { userIds: [w.b.emp.id], leaveTypeIds: [w.b.vac], fromYear: 2026, before: () => 20, after: () => 1 })),
  },

  // Calendar.
  {
    covers: ["calendar:getMonthCalendar", "calendar:getYearCalendar", "calendar:getTeamCalendar"],
    name: "calendars show only the company's leave and holidays",
    run: async ({ ctx, a, b }) => [
      await calendar.getMonthCalendar(ctx, a.emp, "2026-12", "team"),
      await calendar.getMonthCalendar(ctx, a.admin, "2026-12", "everyone"),
      await calendar.getYearCalendar(ctx, a.admin, 2026),
      await calendar.getTeamCalendar(ctx, a.admin, { month: "2026-12", departmentId: b.department }),
      await calendar.getTeamCalendar(ctx, a.admin, { month: "2026-11" }),
    ],
  },
  {
    covers: ["calendar:listCalendarFeeds", "calendar:shouldSuggestCalendarFeed"],
    name: "feed links are the person's own",
    run: async ({ ctx, a }) => [await calendar.listCalendarFeeds(ctx, a.emp), await calendar.listCalendarFeeds(ctx, a.admin), await calendar.shouldSuggestCalendarFeed(ctx, a.pal)],
  },
  {
    covers: ["calendar:renderCalendarFeed"],
    name: "a company's feeds hold none of another company's leave",
    run: async ({ ctx, a }) => [await calendar.renderCalendarFeed(ctx, a.feeds.team, {}), await calendar.renderCalendarFeed(ctx, a.feeds.personal, {})],
    check: (value) => {
      for (const r of value as ReturnType<typeof unwrap<unknown>>[]) assert.ok(isServiceResult(r) && r.ok && r.value, "the feed renders");
    },
  },
  {
    covers: ["calendar:issueCalendarFeed", "calendar:revokeCalendarFeed"],
    name: "issuing and revoking feeds touches no other company's feed",
    run: async ({ ctx, a }) => [await calendar.issueCalendarFeed(ctx, a.pal, "team"), await calendar.revokeCalendarFeed(ctx, a.pal, "team")],
  },
  {
    covers: ["calendar:loadCalendarScope"],
    name: "a calendar scope never reaches into another company",
    run: async ({ t, a, b }) => {
      await t.db.update(schema.companies).set({ departmentScoping: true }).where(eq(schema.companies.id, a.companyId));
      try {
        return [await calendar.loadCalendarScope(t.db, a.companyId, b.emp.id), await calendar.loadCalendarScope(t.db, a.companyId, a.emp.id)];
      } finally {
        await t.db.update(schema.companies).set({ departmentScoping: false }).where(eq(schema.companies.id, a.companyId));
      }
    },
    echoes: ({ b }) => [b.emp.id],
  },
  {
    covers: ["calendar:scopeOf"],
    name: "a scope adds no department the viewer manages in another company",
    run: ({ t, a, b }) =>
      calendar.scopeOf(t.db, a.companyId, { id: b.boss.id, role: "manager", managerId: null, departmentId: null }, { colleagueVisibility: "team", departmentScoping: true }),
    echoes: ({ b }) => [b.boss.id],
  },
  {
    covers: ["calendar:findCompanySettings", "calendar:listHolidayDates", "calendar:listHolidays", "calendar:listHolidayRows"],
    name: "company settings and holidays are read by company",
    run: async ({ t, a }) => [
      await calendar.findCompanySettings(t.db, a.companyId),
      await calendar.listHolidays(t.db, a.companyId, "2026-01-01", "2026-12-31"),
      await calendar.listHolidayRows(t.db, a.companyId, "2026-01-01", "2026-12-31"),
      await calendar.listHolidayDates(t.db, a.companyId, "2026-01-01", "2026-12-31"),
    ],
    check: (value) => assert.ok(!(value as string[][])[3].includes("2026-12-23"), "Bravo's holiday date is not Alpha's"),
  },
  {
    covers: ["calendar:listTeamEntries", "calendar:listPersonalEntries", "calendar:listPersonLeave"],
    name: "calendar entries by company never include another company's leave",
    run: async ({ t, a, b }) => [
      await calendar.listTeamEntries(t.db, a.companyId, "2026-01-01", "2026-12-31", {}),
      await calendar.listTeamEntries(t.db, a.companyId, "2026-01-01", "2026-12-31", { departmentId: b.department }),
      await calendar.listPersonalEntries(t.db, a.companyId, b.emp.id, "2026-01-01", "2026-12-31"),
      await calendar.listPersonLeave(t.db, a.companyId, b.emp.id, "2026-01-01", "2026-12-31"),
    ],
    check: (value) => assert.deepEqual((value as unknown[][]).slice(1), [[], [], []]),
  },

  // Holidays.
  { covers: ["holidays:listHolidaysForAdmin"], name: "Admin → Holidays lists the company's own", run: ({ ctx, a }) => holidays.listHolidaysForAdmin(ctx, a.admin, 2026) },
  {
    covers: ["holidays:addHoliday", "holidays:addHolidayRange", "holidays:addUsFederalHolidays"],
    name: "adding holidays recounts only the company's own leave (Bravo has leave on Dec 1)",
    run: async ({ ctx, a }) => [
      await holidays.addHoliday(ctx, a.admin, { date: "2026-12-01", name: "Alpha day" }),
      await holidays.addHolidayRange(ctx, a.admin, { startDate: "2026-12-08", endDate: "2026-12-09", name: "Alpha days" }),
      await holidays.addUsFederalHolidays(ctx, a.admin, 2027),
    ],
  },
  {
    covers: ["holidays:renameHoliday", "holidays:renameHolidays", "holidays:deleteHoliday", "holidays:deleteHolidays"],
    name: "another company's holidays can be neither renamed nor deleted",
    run: async ({ ctx, a, b }) => [
      await holidays.renameHoliday(ctx, a.admin, b.holiday, "Renamed"),
      await holidays.renameHolidays(ctx, a.admin, [b.holiday], "Renamed"),
      await holidays.deleteHoliday(ctx, a.admin, b.holiday),
      await holidays.deleteHolidays(ctx, a.admin, [b.holiday]),
    ],
  },
  {
    covers: ["holidays:insertHolidays"],
    name: "the import's holiday step writes only to the company it is given",
    run: (w) => inTx(w, (tx) => holidays.insertHolidays(tx, w.a.companyId, [{ date: "2027-03-01", name: "Alpha import" }])),
  },

  // Integrations.
  {
    covers: ["integrations:createWebhookEndpoint", "integrations:listWebhookEndpoints"],
    name: "webhook endpoints are created and listed in the company",
    run: async ({ ctx, a }) => [
      await integrations.createWebhookEndpoint(ctx, a.admin, { url: "https://hooks.example.com/alpha-2", description: "second", eventTypes: ["leave.requested"] }),
      await integrations.listWebhookEndpoints(ctx, a.admin),
    ],
  },
  {
    covers: [
      "integrations:updateWebhookEndpoint",
      "integrations:setWebhookEndpointEnabled",
      "integrations:rotateWebhookSecret",
      "integrations:sendWebhookPing",
      "integrations:redeliverWebhook",
      "integrations:getWebhookEndpoint",
      "integrations:deleteWebhookEndpoint",
    ],
    name: "another company's webhook endpoint can be neither read nor changed",
    run: async ({ ctx, a, b }) => [
      await integrations.getWebhookEndpoint(ctx, a.admin, b.endpoint, undefined),
      await integrations.updateWebhookEndpoint(ctx, a.admin, b.endpoint, { url: "https://evil.example.com/x", description: "x", eventTypes: ["leave.requested"] }),
      await integrations.setWebhookEndpointEnabled(ctx, a.admin, b.endpoint, false),
      await integrations.rotateWebhookSecret(ctx, a.admin, b.endpoint),
      await integrations.sendWebhookPing(ctx, a.admin, b.endpoint),
      await integrations.redeliverWebhook(ctx, a.admin, b.endpoint, b.delivery),
      await integrations.redeliverWebhook(ctx, a.admin, a.endpoint, b.delivery),
      await integrations.deleteWebhookEndpoint(ctx, a.admin, b.endpoint),
    ],
  },
  {
    covers: ["integrations:createApiKey", "integrations:listApiKeys", "integrations:revokeApiKey"],
    name: "API keys are listed by company and another company's key cannot be revoked",
    run: async ({ ctx, a, b }) => [
      await integrations.createApiKey(ctx, a.admin, { name: "Alpha second" }),
      await integrations.listApiKeys(ctx, a.admin),
      await integrations.revokeApiKey(ctx, a.admin, b.apiKey.id),
    ],
  },
  {
    covers: ["integrations:authenticateApiKey"],
    name: "a key authenticates as its own company",
    run: ({ ctx, a }) => integrations.authenticateApiKey(ctx, a.apiKey.key),
    check: (value, { a }) => assert.equal((value as integrations.ApiClient).companyId, a.companyId),
  },
  {
    covers: ["integrations:countLiveApiKeys", "integrations:countLiveEndpoints"],
    name: "live integrations are counted by company",
    run: async ({ t, a, b }) => [
      await integrations.countLiveApiKeys(t.db, a.companyId, b.admin.id),
      await integrations.countLiveEndpoints(t.db, a.companyId, b.admin.id),
    ],
    check: (value) => assert.deepEqual(value, [0, 0]),
  },
  {
    covers: ["integrations:listAdapters", "integrations:syncAdapterNow"],
    name: "adapters are per company (none are installed)",
    run: async ({ ctx, a }) => [await integrations.listAdapters(ctx, a.admin), await integrations.syncAdapterNow(ctx, a.admin, "anything")],
  },
  {
    covers: ["integrations:applyInboundSync"],
    name: "an inbound sync cannot rename another company's person or set their allowance",
    run: ({ ctx, a, b }) =>
      integrations.applyInboundSync(ctx, {
        companyId: a.companyId,
        adapterId: "tenancy",
        trigger: { kind: "admin", actor: a.admin },
        users: [{ email: b.emp.email, name: "Taken Over" }],
        balances: [{ email: b.emp.email, leaveTypeCode: "VAC", year: 2026, days: 1 }],
      }),
    echoes: ({ b }) => [b.emp.email],
  },

  // Leave.
  {
    covers: ["leave:submitLeaveRequest"],
    name: "leave cannot be requested on another company's leave type",
    run: ({ ctx, a, b }) => leave.submitLeaveRequest(ctx, a.emp, draft(b.vac)),
  },
  {
    covers: ["leave:cancelLeaveRequest", "leave:leaveModule"],
    name: "another company's request cannot be cancelled",
    run: async ({ ctx, a, b }) => [await leave.cancelLeaveRequest(ctx, a.admin, b.pending), await leave.leaveModule(ctx).cancelLeaveRequest(a.admin, b.pending)],
  },
  {
    covers: ["leave:addLeaveFor", "leave:previewLeaveFor"],
    name: "leave cannot be added for another company's person, or on its leave type",
    run: async ({ ctx, a, b }) => [
      await leave.addLeaveFor(ctx, a.admin, b.emp.id, draft(a.vac)),
      await leave.addLeaveFor(ctx, a.admin, a.emp.id, draft(b.vac)),
      await leave.previewLeaveFor(ctx, a.admin, b.emp.id, draft(a.vac)),
      await leave.previewLeaveFor(ctx, a.admin, a.emp.id, draft(b.vac)),
    ],
  },
  {
    covers: ["leave:removeLeaveFor"],
    name: "another company's booked leave cannot be removed",
    run: ({ ctx, a, b }) => leave.removeLeaveFor(ctx, a.admin, b.approved, "because"),
  },
  {
    covers: ["leave:getDashboard", "leave:listMyRequests", "leave:getMyRequest"],
    name: "the dashboard and Your requests are the person's own",
    run: async ({ ctx, a, b }) => [
      await leave.getDashboard(ctx, a.admin),
      await leave.getDashboard(ctx, a.emp),
      await leave.listMyRequests(ctx, a.emp, undefined),
      await leave.getMyRequest(ctx, a.admin, b.pending),
    ],
  },
  {
    covers: ["leave:recountLeave"],
    name: "a recount for a new holiday recounts only the company's leave",
    run: (w) =>
      inTx(w, (tx) => leave.recountLeave(tx, w.ctx, w.a.admin, { kind: "holidays", added: [{ date: "2026-12-01", name: "Alpha" }], removed: [] })),
  },
  {
    covers: ["leave:activeContacts"],
    name: "contacts are found only in the company",
    run: ({ t, a, b }) => leave.activeContacts(t.db, a.companyId, [b.boss.id, b.emp.id]),
    check: emptyMap,
  },
  {
    covers: ["leave:lockLeaveRequest", "leave:updateStatusIfCurrent", "leave:reassignIfCurrent"],
    name: "request writes by company never touch another company's request",
    run: (w) =>
      inTx(w, async (tx) => [
        await leave.lockLeaveRequest(tx, w.a.companyId, w.b.pending),
        await leave.updateStatusIfCurrent(tx, { companyId: w.a.companyId, id: w.b.pending, from: "pending" }, { status: "cancelled", decidedAt: new Date(), decisionNote: null }),
        await leave.reassignIfCurrent(tx, { companyId: w.a.companyId, id: w.b.pending, from: w.b.boss.id }, w.a.admin.id),
      ]),
    check: (value) => assert.deepEqual(value, [undefined, undefined, undefined]),
  },
  {
    covers: ["leave:alsoOffFor", "leave:draftCoverage"],
    name: "coverage counts only the company's people",
    run: async ({ t, a, b }) => [
      await leave.alsoOffFor(t.db, a.companyId, [{ id: b.pending, userId: b.emp.id, departmentId: b.department, departmentName: "x", startDate: "2026-12-01", endDate: "2026-12-01", status: "pending" }], a.admin.id),
      await leave.draftCoverage(t.db, a.companyId, b.emp.id, { startDate: "2026-12-01" }),
    ],
    echoes: ({ b }) => [b.pending, b.emp.id, b.department],
    check: (value, { b }) => {
      const [also, coverage] = value as [Map<string, unknown>, string | null];
      assert.ok(!serialize(also).includes(b.pal.name));
      assert.equal(coverage, null);
    },
  },

  // Notifications.
  {
    covers: ["notifications:listEmailsForAdmin", "notifications:getEmailForAdmin", "notifications:previewEmail"],
    name: "Admin → Emails shows the company's own copy",
    run: async ({ ctx, a }) => [
      await notifications.listEmailsForAdmin(ctx, a.admin),
      await notifications.getEmailForAdmin(ctx, a.admin, "leave.requested"),
      await notifications.previewEmail(ctx, a.admin, "leave.requested", { subject: "S {{requesterName}}", message: "M" }),
    ],
  },
  {
    covers: ["notifications:saveEmailCopy", "notifications:resetEmailCopy"],
    name: "saving and resetting copy leaves another company's copy alone",
    run: async ({ ctx, a }) => [
      await notifications.saveEmailCopy(ctx, a.admin, "leave.approved", { subject: "Alpha subject", message: "Alpha message" }),
      await notifications.resetEmailCopy(ctx, a.admin, "leave.requested"),
    ],
  },

  // Organisation: company.
  {
    covers: ["organisation:getCompanySettings", "organisation:getCompanyLogo", "organisation:findCompany"],
    name: "company settings and logo are the company's own",
    run: async ({ ctx, t, a }) => [await organisation.getCompanySettings(ctx, a.admin), await organisation.getCompanyLogo(ctx, a.companyId), await organisation.findCompany(t.db, a.companyId)],
  },
  {
    covers: ["organisation:updateCompanyAppearance", "organisation:updateCompanyLogo", "organisation:removeCompanyLogo"],
    name: "appearance and logo changes stay in the company",
    run: async ({ ctx, a }) => [
      await organisation.updateCompanyAppearance(ctx, a.admin, { theme: "cobalt", corners: "theme" }),
      await organisation.removeCompanyLogo(ctx, a.admin),
      await organisation.updateCompanyLogo(ctx, a.admin, pngImage(64, 64, [1, 2, 3])),
    ],
  },
  {
    covers: ["organisation:saveCompanySettings", "organisation:lockCompanyForChange", "organisation:applyCompanyChanges"],
    name: "company steps write only the company they are given",
    run: (w) =>
      inTx(w, async (tx) => [
        await organisation.lockCompanyForChange(tx, w.a.companyId),
        await organisation.saveCompanySettings(tx, w.a.admin, { name: "Alpha renamed", timezone: "UTC", workingDays: [1, 2, 3, 4, 5], allowancePolicy: balances.ANNUAL_CALENDAR_YEAR }),
        await organisation.applyCompanyChanges(tx, w.a.companyId, { timezone: "UTC" }),
      ]),
  },
  {
    covers: ["services/company-settings:updateCompanySettings"],
    name: "changing working days recounts only the company's leave",
    run: ({ ctx, a }) => companySettings.updateCompanySettings(ctx, a.admin, { name: "Alpha renamed", timezone: "UTC", workingDays: [1, 2, 3, 4], allowancePolicy: balances.ANNUAL_CALENDAR_YEAR }),
  },

  // Organisation: departments.
  {
    covers: ["organisation:listDepartmentsForAdmin", "organisation:listDepartmentManagerChoices", "organisation:createDepartment"],
    name: "departments are created and listed in the company",
    run: async ({ ctx, a }) => [
      await organisation.createDepartment(ctx, a.admin, "Alpha Sales"),
      await organisation.listDepartmentsForAdmin(ctx, a.admin),
      await organisation.listDepartmentManagerChoices(ctx, a.admin),
    ],
  },
  {
    covers: ["organisation:renameDepartment", "organisation:setDepartmentLimit", "organisation:deleteDepartment"],
    name: "another company's department can be neither renamed, limited nor deleted",
    run: async ({ ctx, a, b }) => [
      await organisation.renameDepartment(ctx, a.admin, b.department, "Renamed"),
      await organisation.setDepartmentLimit(ctx, a.admin, b.department, 1),
      await organisation.deleteDepartment(ctx, a.admin, b.department),
    ],
  },
  {
    covers: ["organisation:changeDepartmentManager", "services/department-manager:setDepartmentManager"],
    name: "a department's manager is never another company's department or person",
    run: async (w) => [
      await departmentManager.setDepartmentManager(w.ctx, w.a.admin, w.b.department, w.a.boss.id),
      await departmentManager.setDepartmentManager(w.ctx, w.a.admin, w.a.department, w.b.boss.id),
      await inTx(w, (tx) => organisation.changeDepartmentManager(tx, w.a.admin, w.b.department, w.a.boss.id)).catch((e: unknown) => ({ refused: String(e) })),
      await inTx(w, (tx) => organisation.changeDepartmentManager(tx, w.a.admin, w.a.department, w.b.boss.id)).catch((e: unknown) => ({ refused: String(e) })),
    ],
  },
  {
    covers: [
      "organisation:listDepartments",
      "organisation:findDepartment",
      "organisation:findDepartmentLimits",
      "organisation:findDepartmentManagerIds",
      "organisation:listManagedDepartmentIds",
    ],
    name: "department reads by company never find another company's",
    run: async ({ t, a, b }) => [
      await organisation.listDepartments(t.db, a.companyId),
      await organisation.findDepartment(t.db, a.companyId, b.department),
      await organisation.findDepartmentLimits(t.db, a.companyId, [b.department]),
      await organisation.findDepartmentManagerIds(t.db, a.companyId, [b.department]),
      await organisation.listManagedDepartmentIds(t.db, a.companyId, b.boss.id),
    ],
    check: (value) => {
      const [, found, limits, managers, managed] = value as [unknown, unknown, Map<string, number>, Map<string, string>, string[]];
      assert.equal(found, undefined);
      assert.equal(limits.size + managers.size + managed.length, 0);
    },
  },
  {
    covers: ["organisation:addDepartment", "organisation:clearDepartmentsManagedBy"],
    name: "department steps write only the company they are given",
    run: (w) =>
      inTx(w, async (tx) => [
        await organisation.addDepartment(tx, { companyId: w.a.companyId, name: "Alpha Step" }),
        await organisation.clearDepartmentsManagedBy(tx, w.a.companyId, w.b.boss.id),
      ]),
    check: (value) => assert.deepEqual((value as unknown[])[1], []),
  },

  // Organisation: levels.
  {
    covers: ["organisation:createLevel", "organisation:listLevelsForAdmin", "organisation:listLevels", "organisation:findLevel"],
    name: "levels are created, listed and found in the company",
    run: async ({ ctx, t, a, b }) => [
      await organisation.createLevel(ctx, a.admin, "Alpha Junior"),
      await organisation.listLevelsForAdmin(ctx, a.admin),
      await organisation.listLevels(t.db, a.companyId),
      await organisation.findLevel(t.db, a.companyId, b.level),
    ],
    check: (value) => assert.equal((value as unknown[])[3], undefined),
  },
  {
    covers: ["organisation:renameLevel", "organisation:deleteLevel"],
    name: "another company's level can be neither renamed nor deleted",
    run: async ({ ctx, a, b }) => [await organisation.renameLevel(ctx, a.admin, b.level, "Renamed"), await organisation.deleteLevel(ctx, a.admin, b.level)],
  },

  // Organisation: leave types.
  {
    covers: ["organisation:listLeaveTypesForAdmin", "organisation:createLeaveType", "organisation:getLeaveTypeForAdmin"],
    name: "leave types are created and read in the company",
    run: async ({ ctx, a, b }) => [
      await organisation.createLeaveType(ctx, a.admin, leaveTypeInput("Alpha Parental", "par")),
      await organisation.listLeaveTypesForAdmin(ctx, a.admin),
      await organisation.getLeaveTypeForAdmin(ctx, a.admin, b.vac),
    ],
  },
  {
    covers: ["organisation:updateLeaveType", "organisation:setLeaveTypeArchived", "organisation:reorderLeaveTypes"],
    name: "another company's leave type can be neither edited, archived nor reordered",
    run: async ({ ctx, a, b }) => [
      await organisation.updateLeaveType(ctx, a.admin, b.vac, leaveTypeInput("Taken", "VAC")),
      await organisation.setLeaveTypeArchived(ctx, a.admin, b.vac, true),
      await organisation.reorderLeaveTypes(ctx, a.admin, [b.vac, b.pto]),
      await organisation.reorderLeaveTypes(ctx, a.admin, [b.vac, a.vac, a.pto]),
    ],
  },
  {
    covers: ["organisation:findLeaveType", "organisation:listAllLeaveTypes", "organisation:findLeaveTypeForAdmin", "organisation:findLeaveTypeByCode"],
    name: "leave type reads by company never find another company's",
    run: async ({ t, a, b }) => [
      await organisation.findLeaveType(t.db, a.companyId, b.vac),
      await organisation.findLeaveTypeForAdmin(t.db, a.companyId, b.vac),
      await organisation.listAllLeaveTypes(t.db, a.companyId),
      await organisation.findLeaveTypeByCode(t.db, a.companyId, "VAC"),
    ],
    check: (value) => assert.deepEqual((value as unknown[]).slice(0, 2), [undefined, undefined]),
  },
  {
    covers: ["organisation:addLeaveType", "organisation:applyLeaveTypeChanges"],
    name: "leave type steps write only the company they are given",
    run: async (w) => [
      await inTx(w, (tx) => organisation.addLeaveType(tx, { ...leaveTypeInput("Alpha Step", "stp"), companyId: w.a.companyId, sortOrder: 50 })),
      await inTx(w, (tx) => organisation.applyLeaveTypeChanges(tx, w.a.companyId, w.b.vac, { name: "Taken" })).catch((e: unknown) => ({ refused: String(e) })),
    ],
  },

  // Reports.
  {
    covers: ["reports:getLeaveReport", "reports:exportLeaveReport"],
    name: "the leave report and its CSV count only the company's people",
    run: async ({ ctx, a, b }) => [
      await reports.getLeaveReport(ctx, a.admin, { year: 2026 }),
      await reports.getLeaveReport(ctx, a.admin, { year: 2026, departmentId: b.department }),
      await reports.exportLeaveReport(ctx, a.admin, { year: 2026 }),
      await reports.exportLeaveReport(ctx, a.admin, { year: 2026, departmentId: b.department }),
    ],
  },

  // People (services not yet in a module).
  {
    covers: ["people:getAccount", "people:hasPasskey", "people:renameSelf", "people:setColorMode"],
    name: "account reads and edits are the person's own",
    run: async ({ ctx, a }) => [
      await people.getAccount(ctx, a.pal),
      await people.hasPasskey(ctx, a.pal),
      await people.renameSelf(ctx, a.pal, "Alpha Pal"),
      await people.setColorMode(ctx, a.pal, "dark"),
    ],
  },
  {
    covers: [
      "people:getDeletionPreview",
      "people:exportPersonRecords",
      "people:cancelScheduledDeletion",
      "people:deletePerson",
    ],
    name: "another company's person can be neither previewed, exported nor deleted",
    run: async ({ ctx, a, b }) => {
      const refused = (e: unknown) => ({ refused: String(e) });
      return [
        await people.getDeletionPreview(ctx, a.admin, b.emp.id).catch(refused),
        await people.exportPersonRecords(ctx, a.admin, b.emp.id).catch(refused),
        await people.cancelScheduledDeletion(ctx, a.admin, b.emp.id).catch(refused),
        await people.deletePerson(ctx, a.admin, b.emp.id, { mode: "scrubbed", confirmName: b.emp.name }).catch(refused),
        await people.deletePerson(ctx, a.admin, b.emp.id, { mode: "records_kept", confirmName: b.emp.name }).catch(refused),
      ];
    },
  },
  {
    covers: ["people:previewPeopleImport", "people:importPeople"],
    name: "a people import neither takes over nor reveals another company's people",
    run: async ({ ctx, a, b }) => {
      const csv = ["email,name,role,department,manager_email", `${b.emp.email},Taken Over,admin,,`, `alpha.new@example.com,Alpha New,employee,,${b.boss.email}`].join("\n");
      const refused = (e: unknown) => ({ refused: String(e) });
      return [await people.previewPeopleImport(ctx, a.admin, csv).catch(refused), await people.importPeople(ctx, a.admin, { csv, sendInvites: true }).catch(refused)];
    },
    echoes: ({ b }) => [b.emp.email, b.boss.email],
  },
  {
    covers: [
      "db/members:lockMembers",
      "db/members:lockMember",
      "db/members:findMembers",
      "db/members:findMember",
      "db/members:findContacts",
      "db/members:findPerson",
      "db/members:lockPerson",
      "db/admin-standing:findMemberStanding",
    ],
    name: "member reads by company never find another company's person",
    run: (w) =>
      inTx(w, async (tx) => {
        const { a, b } = w;
        await members.lockMembers(tx, a.companyId, [b.emp.id, b.boss.id]);
        return [
          await members.lockMember(tx, a.companyId, b.emp.id),
          await members.findMembers(tx, a.companyId, [b.emp.id, b.boss.id]),
          await members.findMember(tx, a.companyId, b.emp.id),
          await members.findContacts(tx, a.companyId, [b.emp.id, b.boss.id]),
          await members.findPerson(tx, a.companyId, b.emp.id),
          await members.lockPerson(tx, a.companyId, b.emp.id),
          await findMemberStanding(tx, a.companyId, b.admin.id),
        ];
      }),
    check: (value) => {
      for (const found of value as unknown[]) {
        assert.ok(found === undefined || (Array.isArray(found) && found.length === 0) || (found instanceof Map && found.size === 0), serialize(found));
      }
    },
  },
  {
    covers: ["db/members:listActiveAdmins", "db/members:listActiveMembers", "db/members:listPeopleNames"],
    name: "member lists by company hold only the company's people",
    run: async ({ t, a }) => [
      await members.listActiveAdmins(t.db, a.companyId),
      await members.listActiveMembers(t.db, a.companyId),
      await members.listPeopleNames(t.db, a.companyId, { includeDeleted: true }),
    ],
  },
  {
    covers: ["db/members:updatePerson"],
    name: "a member write by company never changes another company's person",
    run: (w) => inTx(w, (tx) => members.updatePerson(tx, w.a.companyId, w.b.emp.id, { name: "Taken Over", role: "admin" })),
    check: (value) => assert.equal(value, undefined),
  },
  {
    covers: ["people:listPeople", "people:getPersonFormOptions", "people:getPersonDetail"],
    name: "Admin → People lists and opens only the company's people",
    run: async ({ ctx, a, b }) => {
      const refused = (e: unknown) => ({ refused: String(e) });
      return [
        await people.listPeople(ctx, a.admin, { status: "all" }),
        await people.listPeople(ctx, a.admin, { status: "all", departmentId: b.department, query: b.token }),
        await people.getPersonFormOptions(ctx, a.admin, null),
        await people.getPersonFormOptions(ctx, a.admin, b.emp.id).catch(refused),
        await people.getPersonDetail(ctx, a.admin, b.emp.id, 2026).catch(refused),
      ];
    },
    echoes: ({ b }) => [b.token],
  },
  {
    covers: ["people:invitePerson"],
    name: "an invite cannot place someone in another company's department, level or team",
    run: async ({ ctx, a, b }) => {
      const refused = (e: unknown) => ({ refused: String(e) });
      return [
        await people.invitePerson(ctx, a.admin, { ...personInput({ departmentId: b.department }), email: "alpha.a@example.com" }).catch(refused),
        await people.invitePerson(ctx, a.admin, { ...personInput({ managerId: b.boss.id }), email: "alpha.b@example.com" }).catch(refused),
        await people.invitePerson(ctx, a.admin, { ...personInput({ levelId: b.level }), email: "alpha.c@example.com" }).catch(refused),
        await people.invitePerson(ctx, a.admin, { ...personInput(), email: b.emp.email }).catch(refused),
      ];
    },
    echoes: ({ b }) => [b.emp.email],
  },
  {
    covers: ["people:updatePerson", "people:resendInvite", "people:deactivatePerson", "people:reactivatePerson"],
    name: "another company's person cannot be edited, invited, deactivated or reactivated, nor linked to",
    run: async ({ ctx, a, b }) => {
      const refused = (e: unknown) => ({ refused: String(e) });
      return [
        await people.updatePerson(ctx, a.admin, b.emp.id, personInput({ name: "Taken Over" })).catch(refused),
        await people.updatePerson(ctx, a.admin, a.pal.id, personInput({ departmentId: b.department })).catch(refused),
        await people.updatePerson(ctx, a.admin, a.pal.id, personInput({ managerId: b.boss.id })).catch(refused),
        await people.updatePerson(ctx, a.admin, a.pal.id, personInput({ levelId: b.level })).catch(refused),
        await people.resendInvite(ctx, a.admin, b.emp.id).catch(refused),
        await people.deactivatePerson(ctx, a.admin, b.emp.id).catch(refused),
        await people.reactivatePerson(ctx, a.admin, b.emp.id).catch(refused),
      ];
    },
  },
  {
    covers: ["people:getTeamMember"],
    name: "a team member page cannot open another company's person",
    run: async ({ ctx, a, b }) => {
      const refused = (e: unknown) => ({ refused: String(e) });
      return [await people.getTeamMember(ctx, a.admin, b.emp.id).catch(refused), await people.getTeamMember(ctx, a.boss, b.emp.id).catch(refused)];
    },
  },
];

// ---------------------------------------------------------------------------------------
// The REST API: what each route file does (as tests/integration/api.test.ts mirrors it).

type ApiWork = (ctx: ServiceContext, client: integrations.ApiClient, q: URLSearchParams) => Promise<unknown>;
const ROUTES: Record<string, { covers: readonly string[]; work: ApiWork; queries: (w: World) => Record<string, string | undefined>[] }> = {
  users: { covers: ["integrations:listUsersForApi"], work: (ctx, c, q) => integrations.listUsersForApi(ctx, c, parseQuery(usersQuery, q)), queries: () => [{}, { limit: "200" }] },
  "leave-types": { covers: ["integrations:listLeaveTypesForApi"], work: (ctx, c) => integrations.listLeaveTypesForApi(ctx, c), queries: () => [{}] },
  "leave-requests": {
    covers: ["leave:listLeaveRequestsForApi"],
    work: (ctx, c, q) => leave.listLeaveRequestsForApi(ctx, c, parseQuery(leaveRequestsQuery, q)),
    queries: ({ b }) => [{}, { userId: b.emp.id }, { from: "2026-01-01", to: "2026-12-31", status: "pending" }],
  },
  balances: {
    covers: ["integrations:listBalancesForApi"],
    work: (ctx, c, q) => integrations.listBalancesForApi(ctx, c, parseQuery(balancesQuery, q)),
    queries: ({ b }) => [{ year: "2026" }, { year: "2026", userId: b.emp.id }],
  },
  holidays: { covers: ["integrations:listHolidaysForApi"], work: (ctx, c, q) => integrations.listHolidaysForApi(ctx, c, parseQuery(holidaysQuery, q)), queries: () => [{ year: "2026" }] },
  events: { covers: ["integrations:listEventsForApi"], work: (ctx, c, q) => integrations.listEventsForApi(ctx, c, parseQuery(eventsQuery, q)), queries: () => [{}, { limit: "200" }] },
};

describe("tenant isolation", { skip }, () => {
  let t: TestDatabase;
  let w: World;
  let bravoRows: Record<string, string[]>;
  let markers: Set<string>;
  const ran = new Set<string>();

  before(async () => {
    t = await createTestDatabase();
    const a = await seedTenant(t, "alpha", "2026-12-24");
    const b = await seedTenant(t, "bravo", "2026-12-23");
    w = { t, a, b, ctx: a.ctx };
    a.ctx.sent.length = 0;
    a.ctx.signInLinks.length = 0;
    bravoRows = await snapshot(t.db, b.companyId);
    markers = markersOf(bravoRows, b.token);
    assert.ok(markers.size > 40, "Bravo has rows in most tables");
  });
  after(async () => {
    await t?.drop();
  });

  /** Bravo is exactly as seeded, Alpha points at nothing of Bravo's, and no mail or link went to Bravo. */
  async function assertIsolated(what: string, allowed: readonly string[] = []) {
    const now = await snapshot(t.db, w.b.companyId);
    for (const table of Object.keys(bravoRows)) assert.deepEqual(now[table], bravoRows[table], `${what}: Bravo's ${table} changed`);
    const alpha = JSON.stringify(await snapshot(t.db, w.a.companyId));
    assert.deepEqual(leaks(alpha, markers), [], `${what}: Alpha's rows now mention Bravo's`);
    await w.ctx.settle();
    assert.deepEqual(leaks(JSON.stringify(w.ctx.sent), markers, allowed), [], `${what}: an email carried Bravo's data or went to Bravo`);
    assert.deepEqual(leaks(JSON.stringify(w.ctx.signInLinks), markers), [], `${what}: a sign-in link was issued to Bravo`);
    w.ctx.sent.length = 0;
    w.ctx.signInLinks.length = 0;
  }

  test("the seed gave each company its own rows and nothing of the other's", async () => {
    await assertIsolated("seed");
    const alphaMarkers = markersOf(await snapshot(t.db, w.a.companyId), w.a.token);
    assert.deepEqual(leaks(JSON.stringify(bravoRows), alphaMarkers), []);
  });

  test("the checks catch a leak: Bravo's own reads, and a write to Bravo, are flagged", async () => {
    assert.notDeepEqual(leaks(serialize(await organisation.listDepartments(t.db, w.b.companyId)), markers), []);
    assert.notDeepEqual(leaks(serialize(unwrap(await leave.getDashboard(w.b.ctx, w.b.emp))), markers), []);
    const [holiday] = await t.db.select().from(schema.holidays).where(eq(schema.holidays.id, w.b.holiday));
    await t.db.update(schema.holidays).set({ name: "Touched" }).where(eq(schema.holidays.id, w.b.holiday));
    try {
      await assert.rejects(assertIsolated("a write to Bravo"), /Bravo's holidays changed/);
    } finally {
      await t.db.update(schema.holidays).set(holiday).where(eq(schema.holidays.id, w.b.holiday));
    }
    const [pal] = await t.db.select().from(schema.user).where(eq(schema.user.id, w.a.pal.id));
    await t.db.update(schema.user).set({ departmentId: w.b.department }).where(eq(schema.user.id, w.a.pal.id));
    try {
      await assert.rejects(assertIsolated("a link to Bravo"), /Alpha's rows now mention Bravo's/);
    } finally {
      await t.db.update(schema.user).set(pal).where(eq(schema.user.id, w.a.pal.id));
    }
    await assertIsolated("restored");
  });

  for (const c of CASES) {
    test(`${c.covers.join(", ") || "balances (through use cases)"}: ${c.name}`, async () => {
      for (const name of c.covers) ran.add(name);
      let value: unknown;
      let refused = false;
      try {
        value = await c.run(w);
      } catch (e) {
        refused = true;
        value = { refused: String(e) };
      }
      if (isServiceResult(value)) {
        refused = !value.ok;
        value = value.ok ? value.value : value.error;
      }
      const allowed = c.echoes?.(w) ?? [];
      assert.deepEqual(leaks(serialize(value), markers, allowed), [], `returned Bravo's data: ${serialize(value).slice(0, 2000)}`);
      if (!refused && c.check) await c.check(value, w);
      await assertIsolated(c.name, allowed);
    });
  }

  for (const [route, { covers, work, queries }] of Object.entries(ROUTES)) {
    test(`GET /api/v1/${route}: Alpha's key never reads Bravo's rows`, async () => {
      for (const name of covers) ran.add(name);
      ran.add(`api:${route}`);
      const limits = {
        perKey: createRateLimiter({ limit: REQUESTS_PER_KEY_PER_MINUTE, windowMs: 60_000 }),
        unauthorized: createRateLimiter({ limit: UNAUTHORIZED_PER_CLIENT_PER_MINUTE, windowMs: 60_000 }),
      };
      for (const query of queries(w)) {
        const res = await handleApiRequest(
          { ctx: w.ctx, headers: new Headers({ Authorization: `Bearer ${w.a.apiKey.key}` }), client: "198.51.100.7", limits, route: `/api/v1/${route}` },
          (client) => work(w.ctx, client, new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined))),
        );
        const body = await res.text();
        assert.ok(res.status === 200 || res.status === 400, `${route} ${JSON.stringify(query)}: ${res.status} ${body}`);
        assert.deepEqual(leaks(body, markers, Object.values(query).filter((v): v is string => v !== undefined)), [], `${route} ${JSON.stringify(query)} returned Bravo's data`);
      }
      await assertIsolated(`GET /api/v1/${route}`);
    });
  }

  test("every covered export and route has a case, and every case is listed as covered", () => {
    const expected = [...COVERED, ...API_ROUTES_COVERED.map((r) => `api:${r}`)].sort();
    assert.deepEqual([...ran].sort(), expected);
    assert.deepEqual(Object.keys(ROUTES).sort(), [...API_ROUTES_COVERED].sort());
    for (const [route, { covers }] of Object.entries(ROUTES)) {
      const source = readFileSync(`src/app/api/v1/${route}/route.ts`, "utf8");
      for (const name of covers) assert.ok(source.includes(`${name.split(":")[1]}(`), `src/app/api/v1/${route}/route.ts calls ${name}, as its case does`);
    }
  });
});

