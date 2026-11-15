import assert from "node:assert/strict";
import { test } from "node:test";
import { listFiles, read } from "./files";

/**
 * Leave, balances, reports and holidays read the calendar (holiday dates, company
 * settings, whose time off someone sees), so the calendar module imports none of them:
 * only organisation, the module everything reads. Anything that needs the calendar and
 * one of those (a teammate's page with their balances) sits outside the calendar.
 */
test("the calendar module imports no module but organisation", () => {
  const offending = listFiles("src/modules/calendar", /\.ts$/).flatMap((path) =>
    [...read(path).matchAll(/from "(@\/modules\/(?!calendar[/"]|organisation")[^"]*)"/g)].map((m) => `${path}: ${m[1]}`),
  );
  assert.deepEqual(offending, []);
});

/**
 * Whose time off someone sees is one rule, `calendarScopeFor` (src/shared/kernel/calendar-visibility.ts),
 * and the calendar module loads it in one place. Everything else asks `@/modules/calendar`
 * (`loadCalendarScope`, `scopeOf`).
 */
test("calendarScopeFor is called only by the calendar module's scope loader", () => {
  const callers = listFiles("src", /\.tsx?$/).filter((path) => /\bcalendarScopeFor\(/.test(read(path)));
  assert.deepEqual(callers.sort(), ["src/modules/calendar/application/calendar-scope.ts", "src/shared/kernel/calendar-visibility.ts"]);
});

/** A holiday change recounts leave through leave's public API, so holidays may import leave, never the other way. */
test("the leave module never imports holidays", () => {
  const offending = listFiles("src/modules/leave", /\.ts$/).filter((path) => /from "@\/modules\/holidays/.test(read(path)));
  assert.deepEqual(offending, []);
});
