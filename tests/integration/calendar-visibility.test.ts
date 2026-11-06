import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db/types";
import type { Actor } from "@/domain/actor";
import type { ColleagueVisibility } from "@/domain/calendar-visibility";
import { isDomainError } from "@/domain/errors";
import { getCompanySettings, updateCompanySettings } from "@/server/services/admin-company";
import { getMonthCalendar, getTeamCalendar } from "@/server/services/calendar";
import { issueCalendarFeed, renderCalendarFeed } from "@/server/services/calendar-feeds";
import { getTeamMember } from "@/server/services/team-member";
import { companyAudit, seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

// The test clock is 2026-11-01 15:00 UTC: Nov 1 in Chicago, so "this month" is 2026-11.

/** Everyone's names on Who's out, sorted. */
const names = (people: { personName: string }[]) => people.map((p) => p.personName).sort();

describe("who can see whose time off on calendars", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  /**
   * boss (admin); mo (manager) manages ana and bo; ana manages kid; zed (manager)
   * manages cy. Everyone has one approved weekday off in November, with a note that
   * must never reach a calendar.
   */
  async function seeded() {
    const co = await seedCompany(t.db, {
      boss: { role: "admin" },
      mo: { role: "manager" },
      ana: { managerKey: "mo" },
      bo: { managerKey: "mo" },
      kid: { managerKey: "ana" },
      zed: { role: "manager" },
      cy: { managerKey: "zed" },
    });
    const keys = Object.keys(co.people);
    // Seven weekdays: Mon Nov 2 to Fri Nov 6, then Mon 9 and Tue 10.
    const days = ["02", "03", "04", "05", "06", "09", "10"];
    await t.db.insert(schema.leaveRequests).values(
      keys.map((key, i) => ({
        companyId: co.companyId,
        userId: co.people[key].id,
        leaveTypeId: co.pto,
        startDate: `2026-11-${days[i]}`,
        endDate: `2026-11-${days[i]}`,
        dayPortion: "full" as const,
        days: 1,
        status: "approved" as const,
        note: `SECRET-${key}`,
      })),
    );
    const ctx = createTestContext(t.db);
    async function setVisibility(colleagueVisibility: ColleagueVisibility) {
      const { company } = await getCompanySettings(ctx, co.people.boss);
      await updateCompanySettings(ctx, co.people.boss, { ...company, colleagueVisibility });
    }
    return { co, ctx, setVisibility };
  }

  const whoIsOut = async (db: Database, actor: Actor) => names((await getTeamCalendar(createTestContext(db), actor, { month: "2026-11" })).people);

  test("by default everyone sees everyone, as before", async () => {
    const { co } = await seeded();
    for (const key of ["ana", "kid", "mo", "boss"]) {
      assert.deepEqual(await whoIsOut(t.db, co.people[key]), ["Ana", "Bo", "Boss", "Cy", "Kid", "Mo", "Zed"], key);
    }
  });

  test("the setting is the admin's, saved with the company settings and audited", async () => {
    const { co, ctx, setVisibility } = await seeded();
    assert.equal((await getCompanySettings(ctx, co.people.boss)).company.colleagueVisibility, "everyone");
    await setVisibility("team");
    assert.equal((await getCompanySettings(ctx, co.people.boss)).company.colleagueVisibility, "team");
    const [row] = await companyAudit(t.db, co.companyId, "company.");
    assert.deepEqual(
      [(row.before as { colleagueVisibility: string }).colleagueVisibility, (row.after as { colleagueVisibility: string }).colleagueVisibility],
      ["everyone", "team"],
    );
    // Anyone else is refused, and an unknown value is refused before it is stored.
    const { company } = await getCompanySettings(ctx, co.people.boss);
    await assert.rejects(updateCompanySettings(ctx, co.people.mo, { ...company, colleagueVisibility: "self" }), (e) => isDomainError(e, "forbidden"));
    await assert.rejects(updateCompanySettings(ctx, co.people.boss, { ...company, colleagueVisibility: "galaxy" }), (e) =>
      isDomainError(e, "invalid_input"),
    );
  });

  test("team: an employee sees themself, their manager, their manager's other reports and their own reports", async () => {
    const { co, setVisibility } = await seeded();
    await setVisibility("team");
    assert.deepEqual(await whoIsOut(t.db, co.people.ana), ["Ana", "Bo", "Kid", "Mo"]);
    assert.deepEqual(await whoIsOut(t.db, co.people.kid), ["Ana", "Kid"], "kid's manager is ana; nobody else shares her");
    assert.deepEqual(await whoIsOut(t.db, co.people.cy), ["Cy", "Zed"]);
    // Managers and admins still see everyone, for now.
    assert.equal((await whoIsOut(t.db, co.people.mo)).length, 7);
    assert.equal((await whoIsOut(t.db, co.people.boss)).length, 7);
  });

  test("self: an employee sees only their own time off on Who's out", async () => {
    const { co, setVisibility } = await seeded();
    await setVisibility("self");
    assert.deepEqual(await whoIsOut(t.db, co.people.ana), ["Ana"]);
    assert.equal((await whoIsOut(t.db, co.people.zed)).length, 7);
  });

  test("Who's out keeps its fixed four queries with the scope applied", async () => {
    const { co, setVisibility } = await seeded();
    await setVisibility("team");
    let queries = 0;
    const db = t.withLogger({ logQuery: () => void queries++ });
    await whoIsOut(db, co.people.ana);
    assert.equal(queries, 4);
  });

  test("the calendar shows just me by default, and offers My team and Everyone when the viewer may see them", async () => {
    const { co, ctx } = await seeded();
    const mine = await getMonthCalendar(ctx, co.people.ana, "2026-11");
    assert.equal(mine.filter, "me");
    assert.deepEqual(mine.filters, ["me", "team", "everyone"]);
    const people = (cal: typeof mine) => [...new Set(cal.agenda.flatMap((i) => (i.kind === "leave" ? [i.entry.personName] : [])))].sort();
    assert.deepEqual(people(mine), ["Ana"]);
    assert.ok(mine.agenda.every((i) => i.kind !== "leave" || i.entry.isMine));

    const team = await getMonthCalendar(ctx, co.people.ana, "2026-11", "team");
    assert.equal(team.filter, "team");
    assert.deepEqual(people(team), ["Ana", "Bo", "Kid", "Mo"]);
    assert.deepEqual(
      team.agenda.flatMap((i) => (i.kind === "leave" && i.entry.isMine ? [i.entry.personName] : [])),
      ["Ana"],
      "only her own entries are marked hers",
    );

    const everyone = await getMonthCalendar(ctx, co.people.ana, "2026-11", "everyone");
    assert.deepEqual(people(everyone), ["Ana", "Bo", "Boss", "Cy", "Kid", "Mo", "Zed"]);
    // The grid carries the same people as the agenda.
    const inGrid = new Set(everyone.weeks.flat().flatMap((d) => d.entries.map((e) => e.personName)));
    assert.equal(inGrid.size, 7);
    assert.ok(!JSON.stringify(everyone).includes("SECRET"), "never anyone's note");
  });

  test("the calendar's filters follow the setting; a filter the viewer may not use falls back to just me", async () => {
    const { co, ctx, setVisibility } = await seeded();
    await setVisibility("team");
    const asked = await getMonthCalendar(ctx, co.people.ana, "2026-11", "everyone");
    assert.deepEqual(asked.filters, ["me", "team"]);
    assert.equal(asked.filter, "me");
    assert.ok(asked.agenda.every((i) => i.kind !== "leave" || i.entry.isMine));

    await setVisibility("self");
    const self = await getMonthCalendar(ctx, co.people.ana, "2026-11", "team");
    assert.deepEqual(self.filters, ["me"]);
    assert.equal(self.filter, "me");

    // A manager keeps every filter.
    assert.deepEqual((await getMonthCalendar(ctx, co.people.mo, "2026-11", "everyone")).filters, ["me", "team", "everyone"]);
  });

  test("a teammate's page is only reachable for people the viewer may see", async () => {
    const { co, ctx, setVisibility } = await seeded();
    await setVisibility("team");
    for (const key of ["ana", "bo", "mo", "kid"]) assert.ok(await getTeamMember(ctx, co.people.ana, co.people[key].id), key);
    for (const key of ["cy", "zed", "boss"]) {
      await assert.rejects(getTeamMember(ctx, co.people.ana, co.people[key].id), (e) => isDomainError(e, "not_found"), key);
    }
    assert.ok(await getTeamMember(ctx, co.people.mo, co.people.cy.id), "managers still open anyone");
  });

  test("a team calendar link follows its owner's scope, and a change to the setting reaches it at once", async () => {
    const { co, ctx, setVisibility } = await seeded();
    const { token } = await issueCalendarFeed(ctx, co.people.ana, "team");
    const people = async () => {
      const feed = await renderCalendarFeed(ctx, token);
      assert.ok(feed);
      return [...feed.body.matchAll(/^SUMMARY:(\w+):/gm)].map((m) => m[1]).sort();
    };
    assert.equal((await people()).length, 7);
    await setVisibility("team");
    assert.deepEqual(await people(), ["Ana", "Bo", "Kid", "Mo"]);
    // Her own reports go with her: moving kid to another manager takes kid out.
    await t.db.update(schema.user).set({ managerId: co.people.zed.id }).where(eq(schema.user.id, co.people.kid.id));
    assert.deepEqual(await people(), ["Ana", "Bo", "Mo"]);
  });
});
