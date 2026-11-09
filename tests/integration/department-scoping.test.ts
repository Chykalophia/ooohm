import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { isDomainError } from "@/domain/errors";
import { getCompanySettings, updateCompanySettings } from "@/server/services/admin-company";
import { alsoOffFor } from "@/server/services/also-off";
import { getApprovalTriage } from "@/server/services/approvals";
import { getMonthCalendar, getTeamCalendar } from "@/server/services/calendar";
import { issueCalendarFeed, renderCalendarFeed } from "@/server/services/calendar-feeds";
import { getTeamMember } from "@/server/services/team-member";
import { companyAudit, companyEvents, seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

// The test clock is 2026-11-01 15:00 UTC, so "this month" is 2026-11.

const names = (people: { personName: string }[]) => people.map((p) => p.personName).sort();

describe("department scoping: people see only their departments", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  /**
   * boss (admin, no department). Dev, managed by mo: mo, ana and dan, who report to mo.
   * Creative, managed by cara: cara and cy, who reports to cara, plus kid, who sits in
   * Creative but reports to mo. ned has no department and reports to boss.
   *
   * Everyone has one day off on Mon Nov 2: approved, except ana's, which is pending and
   * assigned to mo.
   */
  async function seeded() {
    const co = await seedCompany(t.db, {
      boss: { role: "admin" },
      mo: { role: "manager" },
      ana: { managerKey: "mo" },
      dan: { managerKey: "mo" },
      cara: { role: "manager" },
      cy: { managerKey: "cara" },
      kid: { managerKey: "mo" },
      ned: { managerKey: "boss" },
    });
    const p = co.people;
    const [dev, creative] = await t.db
      .insert(schema.departments)
      .values([
        { companyId: co.companyId, name: "Dev", managerId: p.mo.id },
        { companyId: co.companyId, name: "Creative", managerId: p.cara.id },
      ])
      .returning();
    const place = (keys: string[], departmentId: string) =>
      Promise.all(keys.map((k) => t.db.update(schema.user).set({ departmentId }).where(eq(schema.user.id, p[k].id))));
    await place(["mo", "ana", "dan"], dev.id);
    await place(["cara", "cy", "kid"], creative.id);

    await t.db.insert(schema.leaveRequests).values(
      Object.keys(p).map((key) => ({
        companyId: co.companyId,
        userId: p[key].id,
        leaveTypeId: co.pto,
        startDate: "2026-11-02",
        endDate: "2026-11-02",
        dayPortion: "full" as const,
        days: 1,
        status: key === "ana" ? ("pending" as const) : ("approved" as const),
        approverId: key === "ana" ? p.mo.id : null,
        note: `SECRET-${key}`,
      })),
    );
    const ctx = createTestContext(t.db);
    async function setScoping(departmentScoping: boolean) {
      const { company } = await getCompanySettings(ctx, p.boss);
      await updateCompanySettings(ctx, p.boss, { ...company, departmentScoping });
    }
    return { co, p, ctx, dev, creative, setScoping };
  }

  const everybody = ["Ana", "Boss", "Cara", "Cy", "Dan", "Kid", "Mo", "Ned"];
  const whoIsOut = (db: Database, actor: Actor, departmentId?: string) =>
    getTeamCalendar(createTestContext(db), actor, { month: "2026-11", departmentId });

  test("off by default: nothing changes until an admin turns it on", async () => {
    const { p, ctx } = await seeded();
    assert.equal((await getCompanySettings(ctx, p.boss)).company.departmentScoping, false);
    for (const key of ["mo", "ana", "cy"]) assert.deepEqual(names((await whoIsOut(t.db, p[key])).people), everybody, key);
  });

  test("the setting is the admin's, saved, audited and sent as an event", async () => {
    const { co, p, ctx, setScoping } = await seeded();
    await setScoping(true);
    assert.equal((await getCompanySettings(ctx, p.boss)).company.departmentScoping, true);
    const [row] = await companyAudit(t.db, co.companyId, "company.");
    assert.deepEqual(
      [(row.before as { departmentScoping: boolean }).departmentScoping, (row.after as { departmentScoping: boolean }).departmentScoping],
      [false, true],
    );
    const [event] = await companyEvents(t.db, co.companyId, "company.updated");
    assert.equal((event.payload as { departmentScoping: boolean }).departmentScoping, true);
    const { company } = await getCompanySettings(ctx, p.boss);
    await assert.rejects(updateCompanySettings(ctx, p.mo, { ...company, departmentScoping: false }), (e) => isDomainError(e, "forbidden"));
  });

  test("on: Who's out shows managers and employees only their departments and reports; admins still see everyone", async () => {
    const { p, dev, creative, setScoping } = await seeded();
    await setScoping(true);
    const out = await whoIsOut(t.db, p.mo);
    assert.deepEqual(names(out.people), ["Ana", "Dan", "Kid", "Mo"], "kid sits in Creative but reports to mo");
    assert.deepEqual(
      out.departments.map((d) => d.name),
      ["Dev"],
      "only the viewer's departments are offered",
    );
    assert.deepEqual(names((await whoIsOut(t.db, p.mo, creative.id)).people), ["Ana", "Dan", "Kid", "Mo"], "another department's id falls back");
    assert.deepEqual(names((await whoIsOut(t.db, p.mo, dev.id)).people), ["Ana", "Dan", "Mo"]);
    assert.deepEqual(names((await whoIsOut(t.db, p.cara)).people), ["Cara", "Cy", "Kid"]);
    assert.deepEqual(names((await whoIsOut(t.db, p.ana)).people), ["Ana", "Dan", "Mo"]);
    assert.deepEqual(names((await whoIsOut(t.db, p.ned)).people), ["Ned"], "no department: only themself");
    const admin = await whoIsOut(t.db, p.boss);
    assert.deepEqual(names(admin.people), everybody);
    assert.equal(admin.departments.length, 2);
  });

  test("on: a manager of a department they do not sit in sees it too", async () => {
    const { p, creative, setScoping } = await seeded();
    await t.db.update(schema.departments).set({ managerId: p.mo.id }).where(eq(schema.departments.id, creative.id));
    await setScoping(true);
    assert.deepEqual(names((await whoIsOut(t.db, p.mo)).people), ["Ana", "Cara", "Cy", "Dan", "Kid", "Mo"]);
  });

  test("on: the calendar's Everyone reads My department and holds only it; My team stays inside it", async () => {
    const { p, ctx, setScoping } = await seeded();
    await setScoping(true);
    const people = (cal: Awaited<ReturnType<typeof getMonthCalendar>>) =>
      [...new Set(cal.agenda.flatMap((i) => (i.kind === "leave" ? [i.entry.personName] : [])))].sort();
    const everyone = await getMonthCalendar(ctx, p.kid, "2026-11", "everyone");
    assert.equal(everyone.filter, "everyone");
    assert.equal(everyone.filterLabels.everyone, "My department");
    assert.deepEqual(people(everyone), ["Cara", "Cy", "Kid"]);
    assert.ok(!JSON.stringify(everyone).includes("SECRET"), "never anyone's note");
    // kid's manager mo and mo's other reports sit in Dev: My team leaves them out.
    assert.deepEqual(people(await getMonthCalendar(ctx, p.kid, "2026-11", "team")), ["Kid"]);
    assert.equal((await getMonthCalendar(ctx, p.boss, "2026-11", "everyone")).filterLabels.everyone, "Everyone");
  });

  test("on: a teammate's page outside the viewer's departments is not found", async () => {
    const { p, ctx, setScoping } = await seeded();
    await setScoping(true);
    for (const key of ["ana", "dan", "kid"]) assert.ok(await getTeamMember(ctx, p.mo, p[key].id), key);
    for (const key of ["cy", "cara", "ned", "boss"]) {
      await assert.rejects(getTeamMember(ctx, p.mo, p[key].id), (e) => isDomainError(e, "not_found"), key);
    }
    assert.ok(await getTeamMember(ctx, p.boss, p.cy.id), "admins still open anyone");
  });

  test("on: a team calendar link follows its owner's departments, and a move reaches it at once", async () => {
    const { p, ctx, creative, setScoping } = await seeded();
    const { token } = await issueCalendarFeed(ctx, p.dan, "team");
    const people = async () => {
      const feed = await renderCalendarFeed(ctx, token);
      assert.ok(feed);
      return [...feed.body.matchAll(/^SUMMARY:(\w+):/gm)].map((m) => m[1]).sort();
    };
    assert.equal((await people()).length, 8);
    await setScoping(true);
    assert.deepEqual(await people(), ["Ana", "Dan", "Mo"]);
    await t.db.update(schema.user).set({ departmentId: creative.id }).where(eq(schema.user.id, p.dan.id));
    assert.deepEqual(await people(), ["Cara", "Cy", "Dan", "Kid"]);
  });

  test("on: the also-off line names only people its reader may see", async () => {
    const { co, p, setScoping } = await seeded();
    // ned has no department, so his line looks across the company.
    const ned = { id: "ned-req", userId: p.ned.id, departmentId: null, departmentName: null, startDate: "2026-11-02", endDate: "2026-11-02" };
    assert.equal((await alsoOffFor(t.db, co.companyId, [ned], p.mo.id)).get("ned-req")?.others, 7, "off: everyone, as before");

    await setScoping(true);
    const forMo = (await alsoOffFor(t.db, co.companyId, [ned], p.mo.id)).get("ned-req");
    assert.equal(forMo?.others, 4);
    assert.ok(!/Cy|Cara/.test(forMo?.line ?? ""), forMo?.line);
    assert.equal((await alsoOffFor(t.db, co.companyId, [ned], p.boss.id)).get("ned-req")?.others, 7, "an admin reads everyone");

    // The approvals inbox reads it for its approver.
    const triage = await getApprovalTriage(createTestContext(t.db), p.mo);
    const item = triage.items.find((i) => i.requesterId === p.ana.id);
    assert.equal(item?.alsoOff?.others, 2);
    assert.match(item.alsoOff.line, /^Also off then: (Dan and Mo|Mo and Dan)\.$/);
  });

  test("off, Who's out keeps its four queries; on, it takes one more", async () => {
    const { p, setScoping } = await seeded();
    const count = async () => {
      let queries = 0;
      await whoIsOut(t.withLogger({ logQuery: () => void queries++ }), p.mo);
      return queries;
    };
    assert.equal(await count(), 4);
    await setScoping(true);
    assert.equal(await count(), 5);
  });
});
