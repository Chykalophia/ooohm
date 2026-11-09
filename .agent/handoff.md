return_to: cklph Build v3 / Spec Revise
needs_you: .agent/needs-you.md
resume_at: cklph Build v3 / Spec Revise

## Build (2026-11-09)
- Slices 1-3 committed: `src/components/forms/date-picker-grid.ts`, `src/components/forms/date-picker.tsx`, `DateToken` in `src/app/request-leave-sentence.tsx`, `tests/unit/date-picker-grid.test.ts`.
- Gates this session: typecheck exit 0; lint exit 0 (1 pre-existing warning in site/app.js); `pnpm test` 429/429 pass; `pnpm build` exit 0.
- Browser: `.agent/evidence/date-picker/checks.txt` (88 PASS, 0 FAIL, 1 KNOWN); README there explains method and the KNOWN.
- KNOWN: 320px page overflow (324px) is pre-existing, from the leave-type ChipSelect, present with the picker closed.
- Slice 5 (PR body "Not doing" + assumptions) is for whoever opens the PR; no PR opened here.

## Build (option D, 2026-11-09)
- Reverted `src/domain/calendar-date.ts` to `main`: `git diff main --stat -- src/domain` is empty.
- `utcMs`, `pickerEpochDay` and a local weekday helper now live in `src/components/forms/date-picker-grid.ts` (the grid, the arrow keys and the month clamping use them, so the 0100-01 grid starts at 0099-12-28). `date-picker.tsx` imports `utcMs` from there.
- `isSelectable` now also needs `isCalendarDate(date)`, so 0099 cells show but are disabled. Typed entry already used `isCalendarDate` through `parseTyped`.
- New tests in `tests/unit/date-picker-grid.test.ts` (suite "date picker agrees with the shared validator"): the picker accepts only what `isCalendarDate` accepts at the low and high edges (grid cells, typed text, keyboard and month navigation). The attack test files are unchanged (`git diff c71536d -- tests/unit/*.attack.test.ts` is empty).
- Results: `pnpm test` 439 pass, 0 fail. `pnpm typecheck` clean. `pnpm lint` 0 errors (2 warnings in `site/app.js`, already on main). `pnpm build` succeeded.
- No browser re-run in this step; the UI only changed in that 0099 cells are now disabled. Verify should re-check this.
