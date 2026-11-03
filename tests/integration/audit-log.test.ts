import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db/types";
import { type Adapter, createAdapterRegistry } from "@/server/integrations/adapter";
import { updateCompanySettings } from "@/server/services/admin-company";
import { invitePerson, updatePerson } from "@/server/services/admin-people";
import { encodePageKey, type PageCursor } from "@/domain/paging";
import { AUDIT_PAGE_SIZE, getAuditLog } from "@/server/services/audit-log";
import { rejectsWith } from "./assertions";
import { seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

/**
 * Writes audit rows straight to the table, all stamped with the same instant unless `at`
 * says otherwise. A row with an actor is theirs; one without is the year rollover's,
 * unless the source columns are given.
 */
async function writeAudit(
  db: Database,
  rows: {
    companyId: string;
    actorId?: string | null;
    actorKind?: "user" | "api_key" | "system";
    apiKeyId?: string;
    actorVia?: string;
    actorProcess?: string;
    subjectUserId?: string | null;
    action?: string;
    at: string;
  }[],
) {
  await db.insert(schema.auditLog).values(
    rows.map((r) => ({
      companyId: r.companyId,
      actorKind: r.actorKind ?? (r.actorId ? "user" : "system"),
      actorId: r.actorId ?? null,
      apiKeyId: r.apiKeyId ?? null,
      actorVia: r.actorVia ?? null,
      actorProcess: r.actorProcess ?? (r.actorId || r.actorKind ? null : "year_rollover"),
      subjectUserId: r.subjectUserId ?? null,
      action: r.action ?? "holiday.created",
      entityType: "holiday",
      entityId: randomUUID(),
      before: null,
      after: { name: "x" },
      createdAt: new Date(r.at),
    })),
  );
}

describe("admin: audit log viewer", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  test("shows who, what and a readable summary, newest first, naming people through joins", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: {}, ben: { role: "manager" } });
    const ctx = createTestContext(t.db);
    const { boss, ana, ben } = co.people;
    await updatePerson(ctx, boss, ana.id, { name: "Ana", departmentId: null, managerId: ben.id, role: "employee", canSelfApprove: false });
    await writeAudit(t.db, [{ companyId: co.companyId, action: "allowance.carried_over", subjectUserId: ana.id, at: "2020-01-01T00:00:00Z" }]);

    const log = await getAuditLog(ctx, boss, {});
    assert.deepEqual(
      log.entries.map((e) => [e.label, e.actorLabel, e.subjectName, e.changes]),
      [
        ["Person edited", "Boss", "Ana", ["Manager: none → Ben"]],
        ["Days carried over", "System: year rollover", "Ana", ["Name: x"]],
      ],
    );
    assert.equal(log.timezone, "America/Chicago");
    assert.deepEqual([log.previous, log.next], [null, null], "one page: no pager");
    assert.ok(log.people.some((p) => p.label === "Ben"));
    assert.ok(log.actions.some((a) => a.value === "user.created"));
  });

  test("names who or what made each change, and filtering by a person finds every change with them behind it", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: {}, gone: {} });
    const fake: Adapter = { id: "fakehr", displayName: "Fake HR", handles: () => false, deliver: async () => {}, healthCheck: async () => ({ ok: true }) };
    const ctx = createTestContext(t.db, { adapters: createAdapterRegistry([fake]) });
    const { boss, ana, gone } = co.people;
    const [key] = await t.db
      .insert(schema.apiKeys)
      .values({ companyId: co.companyId, name: "Zapier", prefix: "ooohm_AbCdEfGh", keyHash: "a".repeat(64), createdBy: boss.id })
      .returning();
    const c = co.companyId;
    await writeAudit(t.db, [
      { companyId: c, actorId: boss.id, at: "2026-10-01T12:00:06Z" },
      { companyId: c, actorId: boss.id, actorVia: "adapter_sync:fakehr", at: "2026-10-01T12:00:05Z" },
      { companyId: c, actorId: boss.id, actorKind: "api_key", apiKeyId: key.id, at: "2026-10-01T12:00:04Z" },
      { companyId: c, actorKind: "system", actorProcess: "adapter_sync:fakehr", at: "2026-10-01T12:00:03Z" },
      { companyId: c, actorKind: "system", actorProcess: "adapter_sync:retired", at: "2026-10-01T12:00:02Z" },
      { companyId: c, actorId: gone.id, at: "2026-10-01T12:00:01Z" },
      { companyId: c, actorId: ana.id, at: "2026-10-01T12:00:00Z" },
    ]);
    // People are deactivated, never deleted; if a row ever is, its changes stay a person's.
    await t.db.delete(schema.user).where(eq(schema.user.id, gone.id));

    const log = await getAuditLog(ctx, boss, {});
    assert.deepEqual(
      log.entries.map((e) => [e.actorKind, e.actorLabel]),
      [
        ["user", "Boss"],
        ["user", "Boss, via Fake HR sync"],
        ["api_key", "Boss, via API key ‘Zapier’ (ooohm_AbCdEfGh…)"],
        ["system", "System: scheduled Fake HR sync"],
        ["system", "System: scheduled retired sync"],
        ["user", "A deleted person"],
        ["user", "Ana"],
      ],
    );
    const byBoss = await getAuditLog(ctx, boss, { actorId: boss.id });
    assert.deepEqual(byBoss.entries.map((e) => e.actorLabel), ["Boss", "Boss, via Fake HR sync", "Boss, via API key ‘Zapier’ (ooohm_AbCdEfGh…)"]);
  });

  test("pages by (created_at, id), forwards and back: rows sharing an instant are neither skipped nor repeated", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    // 60 rows in the same microsecond, plus a few around them: 62 rows, three pages of 25.
    await writeAudit(t.db, Array.from({ length: 60 }, () => ({ companyId: co.companyId, at: "2026-10-01T12:00:00.123456Z" })));
    await writeAudit(t.db, [
      { companyId: co.companyId, at: "2026-10-01T12:00:00.123457Z" },
      { companyId: co.companyId, at: "2026-10-01T12:00:00.123455Z" },
    ]);

    const forward: string[][] = [];
    let page: PageCursor | undefined;
    let last: Awaited<ReturnType<typeof getAuditLog>>;
    do {
      last = await getAuditLog(ctx, co.people.boss, { page });
      assert.equal(last.previous === null, forward.length === 0, "only the first page has no previous");
      forward.push(last.entries.map((e) => e.id));
      page = last.next ?? undefined;
    } while (page);
    assert.deepEqual(forward.map((p) => p.length), [25, 25, 12]);
    const seen = forward.flat();
    assert.equal(new Set(seen).size, 62, "no row twice, none skipped");
    const times = await t.db.select({ id: schema.auditLog.id, at: schema.auditLog.createdAt }).from(schema.auditLog);
    const order = new Map(times.map((r) => [r.id, r.at.getTime()]));
    for (let i = 1; i < seen.length; i++) assert.ok(order.get(seen[i - 1])! >= order.get(seen[i])!, "newest first");

    // Back from the last page: the same pages, in the same order within each.
    const backward: string[][] = [];
    page = last.previous ?? undefined;
    while (page) {
      const p = await getAuditLog(ctx, co.people.boss, { page });
      backward.unshift(p.entries.map((e) => e.id));
      assert.ok(p.next, "a page reached going back has a next page");
      page = p.previous ?? undefined;
    }
    assert.deepEqual(backward, forward.slice(0, -1));
  });

  test("oldest first walks the same rows the other way; rows a page are 25, 50 or 100, anything else 25", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    await writeAudit(t.db, Array.from({ length: 60 }, (_, i) => ({ companyId: co.companyId, at: `2026-10-01T12:${String(i).padStart(2, "0")}:00Z` })));
    const all = async (filter: { oldestFirst?: boolean; size?: number }) => {
      const ids: string[] = [];
      const sizes: number[] = [];
      let page: PageCursor | undefined;
      do {
        const p = await getAuditLog(ctx, co.people.boss, { ...filter, page });
        ids.push(...p.entries.map((e) => e.id));
        sizes.push(p.size);
        page = p.next ?? undefined;
      } while (page);
      return { ids, pages: sizes.length, size: sizes[0] };
    };
    const newest = await all({});
    const oldest = await all({ oldestFirst: true });
    assert.deepEqual(oldest.ids, [...newest.ids].reverse());
    assert.equal(newest.ids.length, 60);
    assert.deepEqual([newest.pages, newest.size], [3, 25]);
    assert.deepEqual([(await all({ size: 50 })).pages, (await all({ size: 100 })).pages], [2, 1]);
    for (const size of [0, 7, 1000, Number.NaN]) {
      const r = await all({ size });
      assert.deepEqual([r.pages, r.ids.length, r.size], [3, 60, 25], `${size} reads 25 a page`);
    }
  });

  test("search: every word must match the change's name, who made it or who it is about; filters still apply", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: {}, ben: {} });
    const ctx = createTestContext(t.db);
    const { boss, ana, ben } = co.people;
    const row = (action: string, actorId: string | null, subjectUserId: string | null, minute: number) => ({
      companyId: co.companyId,
      action,
      actorId,
      subjectUserId,
      at: `2026-10-01T12:${String(minute).padStart(2, "0")}:00Z`,
    });
    await writeAudit(t.db, [
      row("leave_request.rejected", boss.id, ana.id, 1),
      row("leave_request.rejected", boss.id, ben.id, 2),
      row("leave_request.approved", boss.id, ana.id, 3),
      row("leave_request.requested", ana.id, ana.id, 4),
      row("holiday.created", boss.id, null, 5),
    ]);
    const found = async (filter: Parameters<typeof getAuditLog>[2]) =>
      (await getAuditLog(ctx, boss, filter)).entries.map((e) => [e.action, e.subjectName]).sort();

    assert.deepEqual(await found({ query: "DECLINED" }), [
      ["leave_request.rejected", "Ana"],
      ["leave_request.rejected", "Ben"],
    ]);
    assert.deepEqual(await found({ query: "declined ana" }), [["leave_request.rejected", "Ana"]], "both words must match");
    assert.deepEqual(await found({ query: "  ben  " }), [["leave_request.rejected", "Ben"]]);
    assert.equal((await found({ query: "boss" })).length, 4, "as the one who made the change");
    assert.deepEqual(await found({ query: "ana nobody-by-this-name" }), [], "a word matching nothing finds nothing");
    assert.deepEqual(await found({ query: "request" }), [["leave_request.requested", "Ana"]], "labels only: 'request' is in every leave_request key, not in 'Leave declined'");
    assert.deepEqual(await found({ query: "ana", action: "leave_request.approved" }), [["leave_request.approved", "Ana"]], "with a filter");
    const log = await getAuditLog(ctx, boss, { query: "  Declined   ana " });
    assert.equal(log.filters.query, "Declined ana", "the search as shown back, spaces tidied");
    assert.equal((await getAuditLog(ctx, boss, { query: "   " })).filters.query, undefined);
  });

  test("a cursor that is not one the log made reads as the first page, not an error", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    await writeAudit(t.db, Array.from({ length: 30 }, (_, i) => ({ companyId: co.companyId, at: `2026-10-01T12:00:${String(i).padStart(2, "0")}Z` })));
    const first = (await getAuditLog(ctx, co.people.boss, {})).entries[0].id;
    const id = "00000000-0000-4000-8000-000000000000";
    const forged = [
      "garbage",
      "",
      encodePageKey(["2026-10-01T12:00:00.123456Z"]),
      encodePageKey(["2026-10-01T12:00:00.123456Z", "not-a-uuid"]),
      encodePageKey(["0000-01-01T00:00:00.000000Z", id]),
      ...["2026-99-99T99:99:99.000000Z", "2026-02-30T12:00:00.000000Z", "2026-10-01T24:00:00.000000Z", "2026-10-01T12:60:00.000000Z"].map((at) =>
        encodePageKey([at, id]),
      ),
    ];
    assert.equal((await getAuditLog(ctx, co.people.boss, { actorId: "x\u0000" })).entries[0]?.id, first, "a NUL person filter is ignored");
    for (const token of forged) {
      for (const direction of ["after", "before"] as const) {
        const page = await getAuditLog(ctx, co.people.boss, { page: { direction, token } });
        assert.equal(page.entries[0]?.id, first, `${direction} ${token}`);
        assert.equal(page.previous, null, `${direction} ${token} is the first page`);
      }
    }
  });

  test("filters by action, actor, person and days in the company's time zone", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: {}, ben: {} });
    const ctx = createTestContext(t.db);
    const { boss, ana, ben } = co.people;
    await writeAudit(t.db, [
      // Sun Nov 1 23:59 in Chicago (CST after the DST change) and Mon Nov 2 00:00.
      { companyId: co.companyId, actorId: ana.id, subjectUserId: ana.id, action: "leave_request.requested", at: "2026-11-02T05:59:00Z" },
      { companyId: co.companyId, actorId: ben.id, subjectUserId: ana.id, action: "leave_request.approved", at: "2026-11-02T06:00:00Z" },
      { companyId: co.companyId, actorId: boss.id, subjectUserId: ben.id, action: "user.updated", at: "2026-10-31T12:00:00Z" },
    ]);
    const actions = async (filter: Parameters<typeof getAuditLog>[2]) => (await getAuditLog(ctx, boss, filter)).entries.map((e) => e.action);

    assert.deepEqual(await actions({ action: "user.updated" }), ["user.updated"]);
    assert.deepEqual(await actions({ actorId: ben.id }), ["leave_request.approved"]);
    assert.deepEqual(await actions({ subjectUserId: ana.id }), ["leave_request.approved", "leave_request.requested"]);
    assert.deepEqual(await actions({ from: "2026-11-01", to: "2026-11-01" }), ["leave_request.requested"]);
    assert.deepEqual(await actions({ from: "2026-11-02" }), ["leave_request.approved"]);
    assert.deepEqual(await actions({ to: "2026-10-31" }), ["user.updated"]);
    assert.deepEqual(await actions({ action: "not.an.action", from: "2026-13-01" }), ["leave_request.approved", "leave_request.requested", "user.updated"], "malformed filters are ignored");

    // The day boundaries follow the company's zone: in UTC both leave rows are on Nov 2.
    await updateCompanySettings(ctx, boss, { name: "Co", timezone: "UTC", workingDays: [1, 2, 3, 4, 5], allowancePolicy: "annual_calendar_year" });
    assert.deepEqual(await actions({ from: "2026-11-02", to: "2026-11-02", subjectUserId: ana.id }), ["leave_request.approved", "leave_request.requested"]);
  });

  test("another company's rows never show, even when filtering by its people; non-admins are refused", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, emp: {} });
    const other = await seedCompany(t.db, { theirs: { role: "admin" }, x: {} });
    const ctx = createTestContext(t.db);
    await invitePerson(ctx, other.people.theirs, { email: `n-${randomUUID().slice(0, 6)}@example.com`, name: "N", departmentId: null, managerId: null, role: "employee", canSelfApprove: false });
    assert.deepEqual((await getAuditLog(ctx, co.people.boss, {})).entries, []);
    assert.deepEqual((await getAuditLog(ctx, co.people.boss, { actorId: other.people.theirs.id })).entries, []);
    assert.ok(!(await getAuditLog(ctx, co.people.boss, {})).people.some((p) => p.id === other.people.x.id));
    await rejectsWith(getAuditLog(ctx, co.people.emp, {}), "forbidden");
  });

  test("a page costs five queries whatever it holds", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: {} });
    let queries = 0;
    const counting = t.withLogger({ logQuery: () => void queries++ });
    const ctx = createTestContext(counting);
    await getAuditLog(ctx, co.people.boss, {});
    const empty = queries;
    await writeAudit(
      t.db,
      Array.from({ length: 80 }, (_, i) => ({
        companyId: co.companyId,
        actorId: i % 2 ? co.people.boss.id : co.people.ana.id,
        subjectUserId: co.people.ana.id,
        at: `2026-10-01T12:00:${String(i % 60).padStart(2, "0")}Z`,
      })),
    );
    queries = 0;
    const full = await getAuditLog(ctx, co.people.boss, { subjectUserId: co.people.ana.id });
    assert.equal(full.entries.length, AUDIT_PAGE_SIZE);
    assert.equal(empty, 5, "company, people, departments, leave types, then the page");
    assert.equal(queries, empty, "no query per row");
  });

  test("the page query runs on an index, newest first, without sorting the company's whole log", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    await writeAudit(t.db, Array.from({ length: 2000 }, (_, i) => ({ companyId: co.companyId, at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString() })));
    await t.query`analyze audit_log`;
    const plan = await t.query<{ "QUERY PLAN": string }>`explain select id from audit_log where company_id = ${co.companyId} order by created_at desc, id desc limit 51`;
    const text = plan.map((r) => r["QUERY PLAN"]).join("\n");
    assert.match(text, /Index (Only )?Scan Backward using audit_log_company_created_idx/);
    assert.doesNotMatch(text, /Sort/);
  });
});
