# holidays

**Tier 2 with a small domain.** The company's holidays: one day or a run of days (an end-of-year shutdown), the US
federal set for a year, rename and delete (Admin → Holidays).

A holiday is stored one row per day, so day counting, the calendar and the API never see ranges. A run added
together shares one name, and the admin screen shows back-to-back days with one name as one entry
(`groupHolidays`), renamed or deleted together by their ids.

## Owns

- Writes to `holidays` (`infrastructure/drizzle-holidays.repository.ts`). Reads of holidays for calendars, day
  counting, the API and the import go through `@/modules/calendar` (`listHolidays`, `listHolidayDates`,
  `listHolidayRows`), because leave reads them and holidays imports leave.

Every change writes an audit row and a `holiday.created`, `.renamed` or `.deleted` event per day, in its
transaction, through `recordAdminChange` (`application/holiday-changes.ts`). Adding or deleting holidays takes
`lockCompany` and recounts the pending and approved requests on those dates in years still open, in the same
transaction, with `recountLeave` from `@/modules/leave`; the people affected are emailed after commit
(`commitThenNotify`). Past years keep their counts. Renaming changes no count.

## Public API (`index.ts`)

Use cases take `(ctx, actor, …)` and return a `ServiceResult`; each fails with `forbidden` for a non-admin
(`canManageHolidays`), before any I/O, and its doc comment lists the other codes.

- `listHolidaysForAdmin` → `HolidayYearDTO` (the year shown and its `HolidayDTO`s).
- `addHoliday` → `AddedHolidayDTO`, `addHolidayRange` → `AddedHolidayRangeDTO`, `addUsFederalHolidays` →
  `AddedFederalHolidaysDTO`: what was added and the `RecountOutcome`.
- `renameHoliday` → `HolidayDTO`, `renameHolidays` → `HolidayDTO[]`, `deleteHoliday` / `deleteHolidays` →
  `RecountOutcome`.
- `insertHolidays`: a step on the TimeOff import's transaction, with no audit row (the import records its own).
- Domain: `holidayRangeDates`, `HOLIDAY_RANGE_MAX_DAYS`, `groupHolidays`, `usFederalHolidays`.

## Inside

- `domain/holiday-range.ts` (runs of days) and `domain/us-federal-holidays.ts` (the eleven federal holidays on
  their observed dates).
- The name, date and year checks stay in `src/domain/holidays.ts` (`normalizeHolidayName`, `assertHolidayDate`,
  `isHolidayYear`): the calendar page and the TimeOff mapping use them too.
- `application/use-cases/`, `application/queries/`, `application/steps/`: one function per file;
  `application/holiday-changes.ts` holds the audit record, the company lock and the year and id checks.
