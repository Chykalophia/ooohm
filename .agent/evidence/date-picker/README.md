# Date picker: browser evidence (Build step, 2026-11-09)

`checks.txt` is the output of `verify.mjs` (88 PASS, 0 FAIL, 1 KNOWN), run against `pnpm build` +
`pnpm start:embedded` on a throwaway PGlite directory, signed in as the seed admin through the real
magic-link flow (`login.mjs`, mail caught by the `smtp.mjs` sink). None of this is in `package.json`;
playwright-core and the headless shell's system libraries were installed under `/tmp` only.

Method notes:
- The sentence is turned on through the real Admin → Appearance action (seed default is the form).
- Theme matrix (AC5): the script sets the same `<html>` attributes and accent variables the root layout
  writes (`htmlAppearance` in `src/lib/appearance.ts`): `data-ui`, `data-mode`, `data-corners`, and
  `--accent`/`--accent-foreground`/`--accent-ink` for the custom accent (#7c3aed). "Automatic" is
  `data-mode="system"` with the browser's colour scheme emulated as dark. The colour check compares every
  element in the dialog against probes of the theme-token utility classes, resolved in that theme.
- AC4(a) "focus on today when no date is set": on `/` the draft always has a default date (today), so the
  check confirms focus on the value, which equals today. The empty-value rule is unit tested
  (`initialFocus` in `tests/unit/date-picker-grid.test.ts`).
- AC6 KNOWN: at 320px `scrollWidth` is 324 with the popup open **and closed**. The overflow is the
  leave-type chip "PTO (Scheduled Time Off)" (`ChipSelect`, untouched by this branch). The popup adds
  0px (304px right edge) and every cell is >= 36px. Follow-up candidate, outside this task's scope.
