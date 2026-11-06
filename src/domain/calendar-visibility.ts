/**
 * Whose time off a person may see on calendars: Who's out, the calendar's filters, a
 * teammate's page and the team calendar link. This is the one place the rule lives;
 * every reader asks {@link calendarScopeFor} and filters by the scope it returns
 * ({@link canSeeOnCalendar} here, `scopeCondition` in the calendar repository in SQL).
 * A new kind of scope (departments, say) is a new {@link CalendarScope} case handled
 * in those two places.
 */
import type { Role } from "./actor";

/**
 * What an employee sees of their colleagues' time off, chosen by an admin for the
 * whole company (`companies.colleague_visibility`): `everyone` in the company, their
 * `team`, or only themselves (`self`). Admins and managers always see everyone.
 */
export const COLLEAGUE_VISIBILITY = ["everyone", "team", "self"] as const;
export type ColleagueVisibility = (typeof COLLEAGUE_VISIBILITY)[number];

/** Today's behaviour: every member sees who is out. */
export const DEFAULT_COLLEAGUE_VISIBILITY: ColleagueVisibility = "everyone";

export function isColleagueVisibility(value: unknown): value is ColleagueVisibility {
  return (COLLEAGUE_VISIBILITY as readonly unknown[]).includes(value);
}

/** The stored setting, read safely: anything unknown is the narrowest view, never a wider one. */
export function readColleagueVisibility(value: string): ColleagueVisibility {
  return isColleagueVisibility(value) ? value : "self";
}

/** How the admin setting names each choice. */
export const COLLEAGUE_VISIBILITY_LABELS: Readonly<Record<ColleagueVisibility, string>> = {
  everyone: "Everyone in the company",
  team: "Their team",
  self: "Only their own",
};

/**
 * The people whose time off a viewer may see:
 *
 * - `everyone`: every active member of the company.
 * - `team`: the viewer, their manager, the others who report to that manager, and the
 *   viewer's own direct reports. With no manager, only the viewer and their reports:
 *   having no manager does not make the other top-level people a team.
 * - `self`: only the viewer.
 */
export type CalendarScope =
  | { kind: "everyone" }
  | { kind: "team"; viewerId: string; managerId: string | null }
  | { kind: "self"; viewerId: string };

/** Who is looking: read fresh from the database, so a new manager or role applies at once. */
export interface CalendarViewer {
  id: string;
  role: Role;
  managerId: string | null;
}

/** The scope `viewer` gets under the company's setting. Admins and managers see everyone. */
export function calendarScopeFor(viewer: CalendarViewer, company: { colleagueVisibility: string }): CalendarScope {
  if (viewer.role === "admin" || viewer.role === "manager") return { kind: "everyone" };
  const visibility = readColleagueVisibility(company.colleagueVisibility);
  if (visibility === "everyone") return { kind: "everyone" };
  if (visibility === "team") return { kind: "team", viewerId: viewer.id, managerId: viewer.managerId };
  return { kind: "self", viewerId: viewer.id };
}

/** Whether `person` (a member of the viewer's company) is within `scope`. */
export function canSeeOnCalendar(scope: CalendarScope, person: { id: string; managerId: string | null }): boolean {
  switch (scope.kind) {
    case "everyone":
      return true;
    case "self":
      return person.id === scope.viewerId;
    case "team":
      return (
        person.id === scope.viewerId ||
        person.managerId === scope.viewerId ||
        (scope.managerId !== null && (person.id === scope.managerId || person.managerId === scope.managerId))
      );
  }
}

/** The calendar's toggles: just my time off, my team's, or everyone's. */
export const CALENDAR_FILTERS = ["me", "team", "everyone"] as const;
export type CalendarFilter = (typeof CALENDAR_FILTERS)[number];

export const CALENDAR_FILTER_LABELS: Readonly<Record<CalendarFilter, string>> = {
  me: "Just me",
  team: "My team",
  everyone: "Everyone",
};

/** The filters a scope allows, narrowest first. Only `me` means there is nothing to toggle. */
export function calendarFiltersFor(scope: CalendarScope): CalendarFilter[] {
  if (scope.kind === "everyone") return ["me", "team", "everyone"];
  if (scope.kind === "team") return ["me", "team"];
  return ["me"];
}

/**
 * The scope the calendar shows for a requested filter. A filter the viewer's scope does
 * not allow, or none at all, falls back to `me`: a link can narrow a view, never widen it.
 */
export function narrowCalendarScope(
  scope: CalendarScope,
  viewer: Pick<CalendarViewer, "id" | "managerId">,
  requested: string | undefined,
): { filter: CalendarFilter; scope: CalendarScope } {
  const allowed = calendarFiltersFor(scope);
  const filter = allowed.find((f) => f === requested) ?? "me";
  if (filter === "everyone") return { filter, scope };
  if (filter === "team") return { filter, scope: { kind: "team", viewerId: viewer.id, managerId: viewer.managerId } };
  return { filter, scope: { kind: "self", viewerId: viewer.id } };
}
