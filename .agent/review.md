# Code Review

Reviewed `feature/review-date-picker-t-352` against `origin/main`. Read the date-picker unit and regression tests before the implementation diff. `git diff --check origin/main...HEAD` exited 0.

## 1. Standards

No findings at medium severity or higher. The calendar calculations live in a DOM-free helper, the picker stays in the presentation layer, and the component uses the existing theme tokens and focus utilities. No new dependencies or changes to shared domain validation appear in the feature diff.

## 2. Spec

No findings at medium severity or higher. The implementation covers R1–R13 and AC1–AC7 in the reviewed code and tests: the form still posts required `YYYY-MM-DD` values, only the request sentence is migrated, keyboard/month arithmetic is unit-tested, the picker honors `min`, and the UI uses themed tokens. `.agent/evidence/date-picker/verify-step/checks.txt` records the browser, theme, viewport, and axe checks; this review did not rerun those checks.

## 3. Omissions

No findings at medium severity or higher. The added tests include supported-year boundary and year-0099 regressions as well as the requested grid/date cases. The existing verify notes identify that browser evidence was collected in headless Chromium and UTC; other browser engines are not covered by the recorded evidence, but the spec does not require them.

## Routing

REVIEW CLEAN: no review findings above low severity.

# Break 1 (red team)

## Pre-mortem

**Headline:** A date-picker boundary bug lets a person submit an unrepresentable date, or traps keyboard focus at the edge of the supported range.

The likely path is typed entry through `parseTyped` / `isSelectable`, grid generation through `pickerGrid` / `pickerEpochDay`, and keyboard movement through `moveFocus` / `addMonthsClamped`. A mismatch with shared `isCalendarDate`, especially around years 0099–0100 or 9999–10000, could pass a value the service rejects or create a malformed date.

## Attack results

No new reproducible bug found; no attack test added. Existing regression tests cover year-100 `Date.UTC` behavior and upper-bound grid/focus behavior. Hostile typed inputs (empty, emoji, full-width digits, invalid day, 100,000-character date, and surrounding whitespace) behaved as expected in a direct run. Every month from 0100 through 9999 produced a 42-cell grid with four-digit dates. Boundary focus stayed at 0100-01-01 / 9999-12-31, and 0099-12-31 remained unselectable.

`corepack pnpm test`: 439 passed, 0 failed. Direct stress run: `all supported grids malformed 0`; typed-input and boundary outputs matched expectations.

Failure injection and concurrent UI interaction were not exercised; the date math is pure and has no shared mutable state. Existing UI verification evidence covers the browser interaction path.
