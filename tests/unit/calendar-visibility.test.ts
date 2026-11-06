import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CALENDAR_FILTERS,
  type CalendarScope,
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

function throwsCode(fn: () => unknown, code: DomainErrorCode) {
  assert.throws(fn, (err) => isDomainError(err, code));
}

test("company settings take a known colleague visibility, and leave it alone when absent", () => {
  const base = { name: "Acme", timezone: "UTC", workingDays: [1, 2, 3, 4, 5], allowancePolicy: "annual_calendar_year" };
  assert.equal(normalizeCompanySettings({ ...base, colleagueVisibility: "team" }).colleagueVisibility, "team");
  assert.equal("colleagueVisibility" in normalizeCompanySettings(base), false);
  throwsCode(() => normalizeCompanySettings({ ...base, colleagueVisibility: "galaxy" }), "invalid_input");
});
