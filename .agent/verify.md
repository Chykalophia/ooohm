# Verify: themed date picker (2026-11-09)

HEAD verified: `c71536d` (plus this step's evidence commit). Every result below was run in this session.

## Gates

| Gate | Command | Result |
|---|---|---|
| Typecheck | `tsc --noEmit` (pnpm isn't on PATH here, so the `node_modules/.bin` binaries ran the package scripts directly) | exit 0, no output |
| Lint | `eslint` | exit 0: 0 errors, 2 warnings (an unused var in `.agent/evidence/.../verify.mjs` and one in `site/app.js`, which was already there) |
| Unit tests | `tsx --conditions=react-server --test "tests/unit/**/*.test.ts"` | 434 tests, 434 pass, 0 fail |
| Build | `next build` | exit 0, all routes compiled |
| Integration tests | not run | no repository, schema or service change on this branch |
| Browser (AC4–AC7) | `verify.mjs` on `next start` + embedded PGlite, signed in as the seed admin through the real magic-link flow | **89 PASS, 0 FAIL** (`.agent/evidence/date-picker/verify-step/checks.txt`) |

Browser setup notes: Chromium's libraries, fontconfig and DejaVu fonts were unpacked under `/tmp` only. With no fonts installed, Chromium segfaults on any form control, even a bare `<input type="date">`; that is the environment, not the app. Nothing was added to `package.json`.

## Acceptance criteria

| AC | Evidence | Status |
|---|---|---|
| AC1 unit (a)–(f) | `tests/unit/date-picker-grid.test.ts`: all AC1(a)–(f) cases pass (12 out-of-month dates, PageDown clamping, Home/End, arrow keys, isSelectable, parseTyped) | MET |
| AC2 typecheck + lint | both exit 0 (above) | MET |
| AC3 greps | `grep 'showPicker\|type="date"' request-leave-sentence.tsx` exit 1 (no match); deps grep on `package.json` exit 1; `git diff main -- package.json pnpm-lock.yaml` is empty | MET |
| AC4 (a)–(f) | checks.txt: dialog named "Choose first day", focus on today; Right Right Enter → Nov 11, focus back on trigger; posted `startDate=2026-11-11`; disabled days before start, clicking one keeps the value; Escape and outside pointer-down keep the value | MET |
| AC5 theme matrix | the 9 themes + Classic dark + auto/OS dark + custom accent + square corners: surface background, accent selected day, theme radius, no colour outside the tokens (4 checks × 13 variants, all PASS) | MET |
| AC6 320px | `scrollWidth` closed 320 / open 320 (no culprit), smallest cell 36.0px, panel = card box (24/272) | MET (first measured this session; Build had recorded 324) |
| AC7 axe | 0 serious/critical in Classic light and Classic dark | MET |
| Resolved ambiguities | reusable `DatePicker`, only the sentence migrated (`git grep date-picker src` → only the sentence imports it); no new package; option C look (`phone-320.png`: display-face month, underline-only typed field, "Today · Mon, Nov 9", underlined today); Monday first; no Clear or year dropdown; card-width phone panel (check passes) | MET |
| Boundaries | **Never: editing validation; Ask first: changing domain date rules.** Fix 2 edited `src/domain/calendar-date.ts`, so `isCalendarDate` and `toEpochDay` changed for every caller (see the gap below) | **GAP** |

## The gap: a domain validation change outside the boundaries

Fix 2 (`c71536d`) routed `isCalendarDate` and `toEpochDay` through a new `utcMs` helper. Measured this session, comparing `main` to HEAD:

| Input | `main` isCalendarDate / toEpochDay | HEAD |
|---|---|---|
| `0050-03-01` | false / -7246 (same as 1950-03-01) | true / -701206 |
| `0099-12-31` | false / 10956 | true / -683004 |
| `1950-03-01`, `2026-11-09`, `0100-01-01` | unchanged | unchanged |

So server-side validation now accepts years 0001–0099 in leave requests (`domain/leave-request.ts`), holidays, ICS, the TimeOff import and the public API's date query (`api/v1/_lib/query.ts`). This is arguably a latent-bug fix (on `main`, `toEpochDay` aliases year 50 onto 1950). But the spec says "Never: editing … validation" and "Ask first: changing domain date rules", and it touches a public API input. Real dates are unaffected.

## Attack tests

| File | Added in | Changed since | Result |
|---|---|---|---|
| `tests/unit/date-picker-boundaries.attack.test.ts` | `296c6ac` | no (`git diff 296c6ac HEAD` empty) | 2/2 pass |
| `tests/unit/date-picker-y2k-bug.attack.test.ts` | `0304dd8` | no (`git diff 0304dd8 HEAD` empty) | 1/1 pass |

## Review findings

There were no critical or high findings (`.agent/review.md`). Medium AC6 320px overflow: fixed; first measured in a browser this session (320/320). Low card-width phone panel: fixed (panel box = card box). Low missing 320px regression check: fixed (`verify.mjs` now fails on overflow; it passed here). Red-team findings (year-9999 overflow, years 0–99): fixed, and the regression tests pass.

## Open risks

- The boundary gap above.
- Browser evidence ran in UTC, at one date (2026-11-09), in headless Chromium only; Safari and Firefox were not checked.
- `README.md` in the evidence folder still describes the Build run's 324px KNOWN; `verify-step/checks.txt` supersedes it.

## Summary for Peter

1. The themed date picker (option C) replaces the browser's native popup in the request sentence; it's built in-house with no new package.
2. All gates pass: typecheck, lint, 434/434 unit tests, production build, and 89/89 browser checks (keyboard, the 13-variant theme matrix, axe, 320px phones).
3. The 320px phone overflow from review is now measured as fixed (page 320px wide, popup open), and both red-team attack tests are untouched and pass.
4. One gap: a red-team fix changed shared date validation, so the server now also accepts years 0001–0099; the spec said not to touch validation without asking.
5. Recommended: move that fix into the picker's own helper and leave server validation as on `main` (a small Build pass); then it's ready to merge.

## PR status

Not opened. `git push -u origin feature/review-date-picker-t-352` failed with "could not read Username for 'https://github.com'", and `gh` is not authenticated in this environment. The branch is committed locally; it needs a push and a draft PR whose body is the summary above.
