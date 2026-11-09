import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CALENDAR_FILTERS,
  type CalendarScope,
  calendarFilterLabel,
  calendarFiltersFor,
  calendarScopeFor,
  canSeeOnCalendar,
  COLLEAGUE_VISIBILITY,
  DEFAULT_COLLEAGUE_VISIBILITY,
  narrowCalendarScope,
  readColleagueVisibility,
} from "@/domain/calendar-visibility";
import { type DomainErrorCode, isDomainError } from "@/domain/errors";
import { normalizeCompanySettings } from "@/domain/company-settings";

const viewer = (role: "employee" | "manager" | "admin", managerId: string | null = "boss") => ({ id: "me", role, managerId });

// A small org: boss manages me and sib; I manage kid; stranger reports to someone else.
const people = {
  me: { id: "me", managerId: "boss" },
  boss: { id: "boss", managerId: null },
  sib: { id: "sib", managerId: "boss" },
  kid: { id: "kid", managerId: "me" },
  stranger: { id: "stranger", managerId: "other" },
  topLevel: { id: "topLevel", managerId: null },
};

function seen(scope: CalendarScope): string[] {
  return Object.values(people)
    .filter((p) => canSeeOnCalendar(scope, p))
    .map((p) => p.id);
}

test("admins and managers see everyone, whatever the company setting", () => {
  for (const role of ["admin", "manager"] as const) {
    for (const colleagueVisibility of COLLEAGUE_VISIBILITY) {
      assert.deepEqual(calendarScopeFor(viewer(role), { colleagueVisibility }), { kind: "everyone" }, `${role} / ${colleagueVisibility}`);
    }
  }
});

test("employees see what the company setting allows: everyone, their team, or only themselves", () => {
  assert.deepEqual(calendarScopeFor(viewer("employee"), { colleagueVisibility: "everyone" }), { kind: "everyone" });
  assert.deepEqual(calendarScopeFor(viewer("employee"), { colleagueVisibility: "team" }), {
    kind: "team",
    viewerId: "me",
    managerId: "boss",
  });
  assert.deepEqual(calendarScopeFor(viewer("employee"), { colleagueVisibility: "self" }), { kind: "self", viewerId: "me" });
});

test("an unknown stored setting degrades to the narrowest view, never a wider one", () => {
  assert.deepEqual(calendarScopeFor(viewer("employee"), { colleagueVisibility: "galaxy" }), { kind: "self", viewerId: "me" });
  assert.equal(readColleagueVisibility("galaxy"), "self");
  assert.equal(readColleagueVisibility("team"), "team");
  assert.equal(DEFAULT_COLLEAGUE_VISIBILITY, "everyone", "today's behaviour stays the default");
});

test("a team is me, my manager, the people who share my manager, and my direct reports", () => {
  assert.deepEqual(seen({ kind: "team", viewerId: "me", managerId: "boss" }), ["me", "boss", "sib", "kid"]);
});

test("with no manager, my team is me and my direct reports; other top-level people are not my team", () => {
  assert.deepEqual(seen({ kind: "team", viewerId: "me", managerId: null }), ["me", "kid"]);
});

test("self sees only me; everyone sees everyone", () => {
  assert.deepEqual(seen({ kind: "self", viewerId: "me" }), ["me"]);
  assert.deepEqual(seen({ kind: "everyone" }), Object.keys(people));
});

test("the calendar offers only the filters the scope allows, me first", () => {
  assert.deepEqual(CALENDAR_FILTERS, ["me", "team", "everyone"]);
  assert.deepEqual(calendarFiltersFor({ kind: "everyone" }), ["me", "team", "everyone"]);
  assert.deepEqual(calendarFiltersFor({ kind: "team", viewerId: "me", managerId: "boss" }), ["me", "team"]);
  assert.deepEqual(calendarFiltersFor({ kind: "self", viewerId: "me" }), ["me"]);
});

test("a filter narrows the scope; one the scope does not allow falls back to me, never wider", () => {
  const me = viewer("employee");
  const everyone: CalendarScope = { kind: "everyone" };
  const team: CalendarScope = { kind: "team", viewerId: "me", managerId: "boss" };
  const self: CalendarScope = { kind: "self", viewerId: "me" };

  assert.deepEqual(narrowCalendarScope(everyone, me, "everyone"), { filter: "everyone", scope: everyone });
  assert.deepEqual(narrowCalendarScope(everyone, me, "team"), { filter: "team", scope: team });
  assert.deepEqual(narrowCalendarScope(everyone, me, "me"), { filter: "me", scope: self });
  assert.deepEqual(narrowCalendarScope(team, me, "everyone"), { filter: "me", scope: self });
  assert.deepEqual(narrowCalendarScope(self, me, "team"), { filter: "me", scope: self });
  assert.deepEqual(narrowCalendarScope(everyone, me, undefined), { filter: "me", scope: self });
  assert.deepEqual(narrowCalendarScope(everyone, me, "nonsense"), { filter: "me", scope: self });
});

// The same kind of org with departments: me in dev and devPeer, devSib with me; kid
// (my report) in creative with sib; boss and stranger in ops; topLevel in none. I also
// manage the qa department, where qaPerson sits.
const staffed = [
  { id: "me", managerId: "boss", departmentId: "dev" },
  { id: "boss", managerId: null, departmentId: "ops" },
  { id: "sib", managerId: "boss", departmentId: "creative" },
  { id: "kid", managerId: "me", departmentId: "creative" },
  { id: "devPeer", managerId: "other", departmentId: "dev" },
  { id: "devSib", managerId: "boss", departmentId: "dev" },
  { id: "qaPerson", managerId: "other", departmentId: "qa" },
  { id: "stranger", managerId: "other", departmentId: "ops" },
  { id: "topLevel", managerId: null, departmentId: null },
];

function seenStaffed(scope: CalendarScope): string[] {
  return staffed.filter((p) => canSeeOnCalendar(scope, p)).map((p) => p.id);
}

const scoped = { colleagueVisibility: "everyone", departmentScoping: true };

test("department scoping is off unless the company turns it on", () => {
  const manager = { ...viewer("manager"), departmentId: "dev", managedDepartmentIds: ["qa"] };
  assert.deepEqual(calendarScopeFor(manager, { colleagueVisibility: "everyone" }), { kind: "everyone" });
  assert.deepEqual(calendarScopeFor(manager, { colleagueVisibility: "everyone", departmentScoping: false }), { kind: "everyone" });
});

test("with department scoping on, managers see their own department and the ones they manage; admins still see everyone", () => {
  const manager = { ...viewer("manager"), departmentId: "dev", managedDepartmentIds: ["qa", "dev"] };
  assert.deepEqual(calendarScopeFor(manager, scoped), { kind: "departments", viewerId: "me", departmentIds: ["dev", "qa"] });
  assert.deepEqual(calendarScopeFor({ ...viewer("admin"), departmentId: "dev" }, scoped), { kind: "everyone" });
});

test("with department scoping on, an employee who could see everyone sees their department; team and self stay as they are", () => {
  const employee = { ...viewer("employee"), departmentId: "dev" };
  assert.deepEqual(calendarScopeFor(employee, scoped), { kind: "departments", viewerId: "me", departmentIds: ["dev"] });
  assert.deepEqual(calendarScopeFor(employee, { ...scoped, colleagueVisibility: "team" }), { kind: "team", viewerId: "me", managerId: "boss" });
  assert.deepEqual(calendarScopeFor(employee, { ...scoped, colleagueVisibility: "self" }), { kind: "self", viewerId: "me" });
});

test("a departments scope is me, my direct reports wherever they sit, and everyone in my departments", () => {
  assert.deepEqual(seenStaffed({ kind: "departments", viewerId: "me", departmentIds: ["dev", "qa"] }), [
    "me",
    "kid",
    "devPeer",
    "devSib",
    "qaPerson",
  ]);
});

test("someone in no department, under department scoping, sees only themself and their reports", () => {
  const scope = calendarScopeFor({ ...viewer("employee"), departmentId: null }, scoped);
  assert.deepEqual(scope, { kind: "departments", viewerId: "me", departmentIds: [] });
  assert.deepEqual(seenStaffed(scope), ["me", "kid"]);
});

test("under department scoping the filters stay, and Everyone reads as my department or departments", () => {
  const one: CalendarScope = { kind: "departments", viewerId: "me", departmentIds: ["dev"] };
  const two: CalendarScope = { kind: "departments", viewerId: "me", departmentIds: ["dev", "qa"] };
  assert.deepEqual(calendarFiltersFor(one), ["me", "team", "everyone"]);
  assert.equal(calendarFilterLabel("everyone", one), "My department");
  assert.equal(calendarFilterLabel("everyone", two), "My departments");
  assert.equal(calendarFilterLabel("everyone", { kind: "everyone" }), "Everyone");
  assert.equal(calendarFilterLabel("team", one), "My team");
  assert.equal(calendarFilterLabel("me", one), "Just me");
});

test("under department scoping, Everyone is the departments and My team never reaches past them", () => {
  const me = viewer("employee");
  const departments: CalendarScope = { kind: "departments", viewerId: "me", departmentIds: ["dev"] };
  assert.deepEqual(narrowCalendarScope(departments, me, "everyone"), { filter: "everyone", scope: departments });
  const team = narrowCalendarScope(departments, me, "team");
  assert.deepEqual(team, { filter: "team", scope: { kind: "team", viewerId: "me", managerId: "boss", departmentIds: ["dev"] } });
  // boss (ops) and sib (creative) share my reporting line but not my department; kid reports to me.
  assert.deepEqual(seenStaffed(team.scope), ["me", "kid", "devSib"]);
});

function throwsCode(fn: () => unknown, code: DomainErrorCode) {
  assert.throws(fn, (err) => isDomainError(err, code));
}

test("company settings take a known colleague visibility, and leave it alone when absent", () => {
  const base = { name: "Acme", timezone: "UTC", workingDays: [1, 2, 3, 4, 5], allowancePolicy: "annual_calendar_year" };
  assert.equal(normalizeCompanySettings({ ...base, colleagueVisibility: "team" }).colleagueVisibility, "team");
  assert.equal("colleagueVisibility" in normalizeCompanySettings(base), false);
  throwsCode(() => normalizeCompanySettings({ ...base, colleagueVisibility: "galaxy" }), "invalid_input");
});

test("company settings take department scoping as a flag, and leave it alone when absent", () => {
  const base = { name: "Acme", timezone: "UTC", workingDays: [1, 2, 3, 4, 5], allowancePolicy: "annual_calendar_year" };
  assert.equal(normalizeCompanySettings({ ...base, departmentScoping: true }).departmentScoping, true);
  assert.equal(normalizeCompanySettings({ ...base, departmentScoping: false }).departmentScoping, false);
  assert.equal("departmentScoping" in normalizeCompanySettings(base), false);
});
