# Plan: themed date picker (request sentence)

Spec: `.agent/spec.md`. Design approved: option C (`.agent/design/CHOSEN.md`, `.agent/design/option-c.html`). Spec's "Design (approved)" section is the visual brief.

## Slice 1: pure grid and keyboard helpers
- Add `src/components/forms/date-picker-grid.ts`, reusing `src/domain/calendar-date.ts` and `calendar.ts` (`addMonths`, `monthGridBounds`, `toEpochDay`/`fromEpochDay`). Functions: `pickerGrid(month)` (12 out-of-month dates for 2026-11), `moveFocus(date, key, shift?)`, `isSelectable(date, min?)`, `parseTyped(text)`, `initialFocus(value, today, min?)`.
- Add `tests/unit/date-picker-grid.test.ts` covering AC1 (a)–(f), plus `initialFocus` (value > today > min).
- **Accept:** `pnpm test -- --test-name-pattern="date picker" && pnpm typecheck` (or `pnpm test`), which exits 0.
- **Out of scope:** any React or DOM code.

## Slice 2: the `DatePicker` component
- Add `src/components/forms/date-picker.tsx` (client). It has the trigger (R2), the dialog (R4, R9), the grid with roving tabindex (R5, R7), the typed field (R3), closing and focus return (R8), a hidden `<input name required value>`, and fit (R12) and motion (R13). It uses tokens only (R11) and follows option C as described in the spec's "Design (approved)" section, including the card-width panel under 40rem and the "Today · Mon, Nov 9" footer.
- **Accept:** `pnpm typecheck && pnpm lint` exits 0, and `grep -nE 'dark:|text-accent[^-]|#[0-9a-fA-F]{3,6}' src/components/forms/date-picker.tsx` returns nothing.
- **Out of scope:** using it anywhere else; holiday shading; ranges.

## Slice 3: migrate `DateToken`
- Replace the inner part of `DateToken` in `src/app/request-leave-sentence.tsx` with `<DatePicker name label value min onChange>`. Remove `overlay` if it is no longer used. Keep the start/end `min` logic unchanged (R10).
- **Accept:** `pnpm typecheck && pnpm lint && pnpm test` exits 0, and `grep -n 'showPicker\|type="date"' src/app/request-leave-sentence.tsx` prints nothing (AC3).
- **Out of scope:** `request-leave-form.tsx`, the admin holidays and audit fields.

## Slice 4: browser verification (no committed tooling)
- Run the app (`pnpm build && pnpm start:embedded`, seeded) and drive it with a throwaway Playwright or Chrome script outside the repo. Do not add it to `package.json`.
- Check AC4 (keyboard, mouse, Escape, outside click, submitted value), AC5 (9 themes, Classic dark and automatic, custom accent, corner override), AC6 (320px fit and cell sizes) and AC7 (axe).
- Save the screenshots to `.agent/evidence/date-picker/` and the command output to `.agent/evidence/date-picker/checks.txt`.
- **Accept:** `checks.txt` shows every AC4–AC7 assertion as PASS, with one screenshot per matrix entry (13 files).
- **Out of scope:** CI integration of browser tests.

## Slice 5: docs and PR notes
- In the PR body, add a "Not doing" list (the other three date fields, Clear, the year dropdown) and the assumptions from challenge.md.
- **Accept:** the PR body contains those items, and `git diff main --stat` touches only the files named in slices 1–3 plus `.agent/`.
- **Out of scope:** changes to `docs/`. No public API or docs contract changes.

## Risks
- Focus trap and outside-click handling on iOS: verify at 320px in slice 4.
- Contrast of the today marker on Graphite (an almost-black accent) and Frost (glass): the slice 4 screenshots and axe check catch these.
