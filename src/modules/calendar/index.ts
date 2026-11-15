import "server-only";
/**
 * The calendar module's public API (see README.md): the month, year and "who's out"
 * views, calendar feed links, and whose time off someone may see (`calendarScopeFor`,
 * loaded here only). Everything outside the module imports from here.
 *
 * Leave, balances and reports read the calendar through this index, so the calendar
 * imports none of them (`tests/architecture/calendar-boundary.test.ts`).
 */

// Views.
export { getMonthCalendar, type MonthCalendarDTO } from "./application/queries/get-month-calendar";
export { getYearCalendar, type YearCalendarDTO } from "./application/queries/get-year-calendar";
export { getTeamCalendar, type TeamCalendarDTO, type TeamCalendarQuery } from "./application/queries/get-team-calendar";
export type { MonthNav, YearNav } from "./application/calendar-viewer";

// Feeds.
export { listCalendarFeeds } from "./application/queries/list-calendar-feeds";
export { shouldSuggestCalendarFeed } from "./application/queries/should-suggest-calendar-feed";
export { renderCalendarFeed } from "./application/queries/render-calendar-feed";
export { issueCalendarFeed } from "./application/use-cases/issue-calendar-feed";
export { revokeCalendarFeed } from "./application/use-cases/revoke-calendar-feed";
export { revokeFeedsOnDeactivation } from "./application/steps/revoke-feeds-on-deactivation";

// Whose time off someone may see: the only loader of `calendarScopeFor`.
export { loadCalendarScope, scopeOf } from "./application/calendar-scope";

// Reads for other modules, on the executor the caller passes.
export { findCompanySettings } from "./application/queries/find-company-settings";
export { listCompanies } from "./application/queries/list-companies";
export { listHolidayDates } from "./application/queries/list-holiday-dates";
export { listHolidays } from "./application/queries/list-holidays";
export { listHolidayRows } from "./application/queries/list-holiday-rows";
export { listTeamEntries } from "./application/queries/list-team-entries";
export { listPersonalEntries } from "./application/queries/list-personal-entries";
export { listPersonLeave } from "./application/queries/list-person-leave";

export { toTeamEntry } from "./application/dto";
export type { CalendarHolidayDTO, CalendarFeedsDTO, FeedSummary, IssuedFeedDTO, RenderedFeed } from "./application/dto";
export { calendarFilterParamSchema, monthParamSchema } from "./application/schemas";
