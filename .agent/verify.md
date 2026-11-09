# Verify: themed date picker (second pass, 2026-11-09)

HEAD verified: `49676e4` (plus this step's evidence commit). Everything below was run in this session. pnpm isn't on PATH, so the package scripts ran through `node_modules/.bin`.

## Gates

| Gate | Command | Result |
|---|---|---|
| Typecheck | `tsc --noEmit` | exit 0 |
| Lint | `eslint` | exit 0: 0 errors, 2 warnings (an unused var in `.agent/evidence/.../verify.mjs` and one in `site/app.js`, which was already on main) |
| Unit tests | `tsx --conditions=react-server --test "tests/unit/**/*.test.ts"` | 440 tests, 440 pass, 0 fail |
| Build | `next build` | exit 0, all routes compiled |
| Integration tests | not run | `git diff main --stat -- src/domain src/server src/db` is empty: no service, repository or schema change |
| Browser (AC4–AC7) | `verify.mjs` on `next build` + `next start`, embedded PGlite, seed admin signed in through the real magic-link flow | **89 PASS, 0 FAIL** (`.agent/evidence/date-picker/verify-step-2/checks.txt`) |

The browser run was repeated because `02b5596` and `49676e4` changed the picker source after the previous browser evidence was recorded. Chromium's libraries and the DejaVu fonts were unpacked under `/tmp` only. playwright-core and axe-core were installed in `/tmp/pw`. Nothing was added to `package.json`.

## Acceptance criteria

| AC | Evidence | Status |
|---|---|---|
| AC1 unit (a)–(f) | `tests/unit/date-picker-grid.test.ts`, 16/16 pass: 42-cell grid with 12 out-of-month days, PageDown clamping (2026: Feb 28; 2024: Feb 29), Home/End, arrow keys across a year boundary, `isSelectable`, `parseTyped` | MET |
| AC2 typecheck + lint | both exit 0 | MET |
| AC3 greps | the `showPicker\|type="date"` grep on the sentence exits 1 (no match); the dependency grep on `package.json` exits 1 | MET |
| AC4 (a)–(f) | checks.txt: the dialog is named "Choose first day" and focus starts on today (2026-11-09); Right, Right, Enter closes it, returns focus to the trigger and the token shows "Wed, Nov 11"; the form posts `startDate=2026-11-11`; end-date cells before the start are `aria-disabled` and clicking one keeps the value; Escape and a pointer-down outside both keep the value | MET |
| AC5 theme matrix | 13 variants (9 themes, Classic dark, automatic with the OS set to dark, a custom accent, square corners) × 4 checks: the surface background, the accent on the selected day, the theme radius, and no colour outside the theme tokens. All PASS | MET |
| AC6 320px | `scrollWidth` is 320 with the popup closed and 320 with it open; the smallest cell is 36.0px; the panel matches the card box (24/272) | MET |
| AC7 axe | 0 serious or critical violations in Classic light and Classic dark | MET |
| Resolved ambiguities | A reusable `DatePicker`, used only by the sentence (`git grep -l date-picker src`: the sentence plus the two component files). No new package. Option C look (`verify-step-2/theme-classic-dark.png`: display-face month, underline-only typed field, "Today · Mon, Nov 9", underlined today). Monday-first. No Clear button or year dropdown. Card-width panel on phones | MET |
| Boundaries / Option D | `git diff main -- src/domain` is empty, so shared validation is exactly as on `main`. The picker imports `isCalendarDate` for `isSelectable`, `parseTyped` and `initialFocus` (`date-picker-grid.ts:5,120,126,131`). The suite "date picker agrees with the shared validator" passes 5/5 | MET (the earlier gap is closed) |

## Attack tests

| File | Added in | Changed since | Result |
|---|---|---|---|
| `tests/unit/date-picker-boundaries.attack.test.ts` | `296c6ac` | no (0-line diff to HEAD) | pass |
| `tests/unit/date-picker-y2k-bug.attack.test.ts` | `0304dd8` | no | pass |
| `tests/unit/date-picker-grid-alignment.attack.test.ts` | `8bb37de` | no | pass |

Running the three attack files together with the grid test gives 20/20 pass. Note: Fix 2 (`49676e4`) changed one assertion in the non-attack file `date-picker-grid.test.ts`. The 9999-12 grid used to end on 9999-12-31; the new assertion is that every cell is four digits and ≤ 9999-12-31. This follows from the attack test's Monday-first requirement and is not a weakened attack test.

## Review findings

- Code Review (second pass): REVIEW CLEAN, with no critical or high findings.
- First review: one medium finding (320px overflow). It is fixed and was measured again here (320/320).
- Red-team findings, all fixed with regression tests that pass:
  - year-9999 overflow;
  - years 0–99 / `Date.UTC`;
  - the Dec 9999 grid alignment.
- Previous Verify gap (domain change): resolved through option D, as above.

## Open risks

- Browser evidence was collected in headless Chromium, in UTC, on a single date (2026-11-09). Safari and Firefox were not checked.
- 9999-12-27 to 9999-12-31 can't be clicked in the grid, which stops at the week ending 9999-12-26 to stay Monday-first. Those days can still be typed or reached by keyboard. This is a theoretical edge case.
- The Build-step `README.md` in the evidence folder still describes an old 324px KNOWN. `verify-step-2/checks.txt` supersedes it.

## Summary for Peter

1. The themed date picker (option C) replaces the browser's native popup in the request sentence. It is built in-house with no new package.
2. Every gate passes: typecheck, lint, 440/440 unit tests, the production build, and 89/89 browser checks (keyboard, 13 theme variants, axe, 320px phones).
3. Your option D is in place: shared server date validation is byte-for-byte as on `main`, and the picker uses the same validator, so the two can't disagree.
4. All three red-team attack test files are unchanged since they were added, and they pass.
5. Not doing in this PR: the request form, holiday and audit date fields still use the native picker (follow-ups). Only Chromium was tested.
