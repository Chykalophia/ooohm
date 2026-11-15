# reports

**Tier 2, query only.** The leave report admins and managers see on `/reports`, and its CSV export. It reads leave,
people, departments, leave types, holidays and balances, and writes nothing.

## Owns

No tables. It reads `user`, `leave_requests` and `leave_request_days` through
`infrastructure/drizzle-reports.repository.ts`, and companies, departments, leave types, holidays and balances
through the services and repositories that own them.

## Public API (`index.ts`)

- `getLeaveReport(ctx, actor, query)` → `ServiceResult<LeaveReportDTO>`: fails with `not_found` for anyone but
  admins and managers, and with `no_company`.
- `exportLeaveReport(ctx, actor, query)` → `ServiceResult<LeaveReportExport>`: the people table as a CSV file.
- `readReportQuery(params)`, `searchParamsRecord(urlParams)`, `LeaveReportQuery`: `?year=` and `?department=`, read
  the same way by the page and the export.
- `canViewReports(actor)`, `canSeeReportBalances(actor, managersSeeDetails)`, `REPORT_TREND_YEARS`.
- `toLeaveReportDTO`, and the types `LeaveReportDTO`, `ReportDepartmentDTO`, `ReportNav`, `LeaveReport`, `ReportScope`.
- `presentLeaveReport(dto)` (`LeaveReportPresentation`) and `typesInMonths(report)`: the page's view model.

## Inside

- `domain/leave-report.ts`: the pure report (`buildLeaveReport`), the month split (`allocateYearToMonths`), scope
  and visibility rules, and the CSV.
- `application/queries/`: `get-leave-report.ts` (eight queries at most, six without balances) and
  `export-leave-report.ts`.
- `application/dto.ts`, `application/schemas.ts`.
- `ui/report-presenter.ts`: labels, links and chart items for `src/app/reports/page.tsx`. The page's tables sit
  beside it in `src/app/reports/report-tables.tsx`.

The module's domain still uses `src/domain` helpers (actor, calendar dates, day counting, CSV) that move to
`src/shared/kernel` or their own modules in later phases; those edges are in the dependency-cruiser baseline.
