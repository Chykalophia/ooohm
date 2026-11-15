# calendar

**Tier 2 with domain rules in `src/shared/kernel`.** What people see of the company's time off: the month and year views,
Who's out, the calendar feed links (iCalendar) and the one rule of whose time off someone sees
(`calendarScopeFor`), which this module alone loads.

Leave, balances, reports, approvals, holidays and integrations read the calendar through this index (holiday
dates, the company's calendar settings, leave entries, the scope), so the calendar imports no module but
organisation (`tests/architecture/calendar-boundary.test.ts`). Code that needs the calendar and one of those
stays outside it: the teammate page (`getTeamMember` in `@/modules/people`) also reads balances and leave's
permissions.

## Owns

- `calendar_feed_tokens` (`infrastructure/drizzle-calendar-feeds.repository.ts`): only the token's SHA-256 and its
  last 4 characters are stored.
- The calendar reads (`infrastructure/drizzle-calendar.repository.ts`): holidays, the company's calendar settings,
  the viewer, and pending and approved leave entries, selected without notes (only `listPersonLeave`, for the
  teammate page, carries the days and notes, which that page shows only to those allowed). `scopeCondition` is the
  SQL form of a `CalendarScope`. `activeInRange`, the date bound both this and leave's repository use, is in
  `src/shared/lib/db/active-leave.ts`.

Issuing and revoking a feed write an audit row and a `calendar_feed.issued` / `.revoked` event in the same
transaction, under the person's member lock (`application/feed-changes.ts`); neither carries the token.

## Public API (`index.ts`)

Queries and use cases that can fail return a `ServiceResult`.

- Views: `getMonthCalendar`, `getYearCalendar`, `getTeamCalendar` (`no_company` when the company is missing).
- Feeds: `listCalendarFeeds` → `CalendarFeedsDTO`, `issueCalendarFeed` → `IssuedFeedDTO` (the only time the
  link exists outside the caller), `revokeCalendarFeed` → whether a link was live (`invalid_input` for an unknown
  kind, `forbidden` for an inactive member), `renderCalendarFeed` → `RenderedFeed` or `null` for any token that
  opens nothing (`rate_limited` when the route's limiter refuses), `shouldSuggestCalendarFeed` (never fails), and
  `revokeFeedsOnDeactivation`, a step on the deactivation's transaction.
- Scope: `loadCalendarScope` and `scopeOf`, on the executor the caller passes. Every screen that shows colleagues'
  leave filters by it.
- Reads for other modules, on the caller's executor: `findCompanySettings`, `listCompanies`, `listHolidayDates`,
  `listHolidays`, `listHolidayRows` (with ids, as `CalendarHolidayDTO`), `listTeamEntries`,
  `listPersonalEntries`, `listPersonLeave`; `toTeamEntry` labels a team row without the email.
- Schemas: `monthParamSchema`, `calendarFilterParamSchema`.

## Inside

- `application/queries/`, `application/use-cases/`, `application/steps/`: one function per file.
  `calendar-scope.ts` (the scope loader), `calendar-viewer.ts` (month and year nav, the viewer with their scope),
  `feed-changes.ts`, `dto.ts`, `schemas.ts`.
- The pure rules sit in `src/shared/kernel`: `calendar.ts` (grids, agendas, months), `calendar-visibility.ts`
  (`calendarScopeFor`, `canSeeOnCalendar`, colleague visibility), `calendar-feed.ts` and `ics.ts`. Client
  components (the date picker, month nav, leave chips) and `src/shared/kernel/company-settings.ts` and `events.ts` import
  them, and none of those may import a module's files.
