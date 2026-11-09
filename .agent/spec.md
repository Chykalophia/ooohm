# Spec: themed date picker for the request sentence

Sources: `.agent/challenge.md`, `.agent/answers.md` (Round 1). Task: the request sentence's date picker works, but it is the browser's native popup, which looks dated and ignores the company theme.

## Problem

`DateToken` (`src/app/request-leave-sentence.tsx:140-188`) overlays an invisible `<input type="date">` and opens the browser's own popup with `showPicker()`. CSS cannot style that popup, so it does not follow the company theme, the accent, the corner style or (reliably) dark mode.

## In scope

1. A new reusable client component, `DatePicker`, in `src/components/forms/date-picker.tsx`. It has a trigger and a themed calendar popup and uses no new package.
2. Pure, DOM-free helpers for the popup's grid and keyboard moves, in `src/components/forms/date-picker-grid.ts`. Unit tests cover them.
3. `DateToken` in `src/app/request-leave-sentence.tsx` switches to `DatePicker`. It is the only call site migrated.

## Out of scope (follow-ups, listed in the PR's "Not doing")

- The date fields in `src/app/request-leave-form.tsx:196-205`, `src/app/admin/holidays/page.tsx:39` and `src/app/admin/audit/page.tsx:204-205`.
- A Clear action, a year dropdown, range selection in one popup, and holiday or weekend shading in the popup.
- Any change to date validation, day counting, server actions, schema, permissions or `package.json` dependencies.

## Requirements

R1. **Form contract unchanged.** The form posts one field per date, named `startDate` / `endDate` as today, with a `YYYY-MM-DD` value. The field is `required`: submitting with it empty is blocked by the browser, the same way as today.
R2. **Trigger.** The sentence still reads as text. The token shows `formatShortDay(value)`, or "pick a date" when empty, using the existing `token` class. The trigger is a `<button type="button">` with `aria-haspopup="dialog"`, `aria-expanded` that matches the popup state, and an accessible name made of the field label plus the current date (for example "First day, Monday, November 23, 2026").
R3. **Typed entry.** Keyboard and screen-reader users can type a date without the popup. Inside the popup there is a visible text field labelled with the field label. It accepts `YYYY-MM-DD`; a valid date that is not before `min` updates the value and moves the grid to that month. Any other text leaves the value unchanged and sets `aria-invalid="true"` on the field.
R4. **Popup layout.** From top to bottom:
- a header with a "Previous month" button, the month label (for example "November 2026", in an `aria-live="polite"` element) and a "Next month" button;
- a Monday-first weekday header (Mon to Sun, each abbreviation with the full day name as its accessible name);
- a 7-column grid of 6 rows, so the popup's height doesn't jump between months;
- a footer with a "Today" button.
R5. **Days.**
- Days from the adjacent months are shown in `text-muted` and can be selected (selecting one also moves the grid to its month).
- Today has a visible marker that doesn't rely on colour alone (a ring or underline), and its accessible name includes "today".
- The selected day uses `bg-accent text-on-accent` (or the closest existing on-accent token) and has `aria-selected="true"`.
- Days before `min` are `aria-disabled="true"`, look muted, and do nothing on click, Enter or Space.
R6. **Opening and focus.** Opening the popup (click, Enter or Space on the trigger) moves focus to the selected day; with no value, to today; if that day is before `min`, to `min`. The grid shows that day's month.
R7. **Keyboard on the grid** (WAI-ARIA APG date picker dialog):
- Left/Right: ±1 day. Up/Down: ±7 days.
- Home/End: the first/last day (Mon/Sun) of the focused week.
- PageUp/PageDown: ±1 month, keeping the day number and clamping to the month's last day (Jan 31 + 1 month = Feb 28, or Feb 29 in a leap year). Shift+PageUp/PageDown: ±1 year with the same clamping.
- Enter/Space: pick the focused day.
- Focus may land on a disabled day, but cannot pick it.
- A roving tabindex: exactly one day cell has `tabIndex=0`.
R8. **Closing.**
- Picking a day (click, Enter or Space) sets the value, calls `onChange`, closes the popup and returns focus to the trigger.
- "Today" does the same with today's date, unless today is before `min`, in which case the button is disabled.
- Escape and a pointer-down outside the popup close it without changing the value and return focus to the trigger.
- Tab cycles focus within the dialog: typed field, previous, next, grid, Today.
R9. **Semantics.** The popup is `role="dialog"` with `aria-modal="true"`. Its accessible name is the field label (for example "Choose first day"). The grid is `role="grid"`, with `role="gridcell"` buttons.
R10. **Min interplay.** The end date keeps `min={startDate}`. Picking a start date after the current end date pushes the end date to match, as today (`request-leave-sentence.tsx` existing logic stays authoritative and unchanged).
R11. **Theme tokens only.**
- Surfaces use `bg-surface`, `border-border`, `text-foreground`/`text-muted` and the accent tokens.
- Accent text is `text-accent-ink`, never `text-accent`.
- Focus uses `focusRing`, and buttons use the `styles.ts` recipes where one exists.
- Corners use the theme's radius utilities, so `data-corners` overrides apply.
- No palette classes, `dark:` variants, hex colours or inline colour styles.
- Forced-colours mode keeps the selected day and focus visible (`forced-colors:` outline as in `month-grid.tsx`).
R12. **Fit.**
- The popup is anchored under the trigger and is at most `min(20rem, 100vw - 2rem)` wide.
- At a 320px-wide viewport, opening it causes no horizontal page scroll (`document.documentElement.scrollWidth <= 320`).
- Day cells are at least 40×40 CSS px when the popup is at its full width, and at least 36×36 at 320px.
R13. **Calm.** One main action (pick a day). No animation longer than 150ms, and none at all under `prefers-reduced-motion: reduce`.

## Acceptance criteria (testable)

AC1. `pnpm test` passes, including a new `tests/unit/date-picker-grid.test.ts` that asserts:
- (a) `pickerGrid("2026-11")` returns 42 dates, from `2026-10-26` to `2026-12-06`, with `inMonth` false for exactly the 12 dates outside November (Oct 26–31 and Dec 1–6);
- (b) `moveFocus("2026-01-31", "PageDown")` returns `2026-02-28`, and `moveFocus("2024-01-31", "PageDown")` returns `2024-02-29`;
- (c) `moveFocus("2026-11-11", "Home")` returns `2026-11-09`, and `"End"` returns `2026-11-15`;
- (d) the arrow keys give ±1/±7 days across month and year boundaries (`2026-12-31` + Right = `2027-01-01`);
- (e) `isSelectable("2026-11-08", "2026-11-09")` is false and `isSelectable("2026-11-09", "2026-11-09")` is true;
- (f) `parseTyped("2026-02-30")` and `parseTyped("11/09/2026")` return `null`, and `parseTyped("2026-11-09")` returns `"2026-11-09"`.

AC2. `pnpm typecheck` and `pnpm lint` exit 0. Lint enforces the no-palette and no-`dark:` rules and the components-must-not-import-`src/app` rule.

AC3. `grep -n 'showPicker\|type="date"' src/app/request-leave-sentence.tsx` returns no matches. `grep -rn '"react-day-picker\|date-fns\|dayjs\|@radix' package.json` returns no matches.

AC4. In a browser on `/` (request sentence), signed in with the seed admin:
- (a) clicking the first date token opens a dialog whose accessible name contains "first day"; focus is on today's cell when no date is set;
- (b) pressing Right twice and then Enter closes the dialog, focus is back on the trigger, and the token shows the date two days after today;
- (c) the form submits `startDate=<that YYYY-MM-DD>`;
- (d) for the end date, cells before the start date have `aria-disabled="true"`, and clicking one leaves the value unchanged;
- (e) Escape closes the popup without changing the value;
- (f) a pointer-down outside it does the same.

AC5. Theme matrix: screenshots of the open popup in each of the 9 themes (classic, cobalt, marigold, saffron, graphite, plum, signal, forest, frost), plus Classic dark and Classic automatic with the OS set to dark, plus one custom accent and one corner override. In each, the popup background equals the theme's surface token and the selected day uses the accent. A computed-style check finds no element inside the popup whose `color` or `background-color` falls outside the set of resolved theme-token values.

AC6. At a 320×640 viewport, with the popup open, `document.documentElement.scrollWidth <= 320`, and every day cell's bounding box is at least 36×36.

AC7. axe-core (or an equivalent check in the browser step) reports 0 serious or critical violations inside the open dialog in Classic light and Classic dark.

## Boundaries

- **Always:** use theme tokens and the `styles.ts` recipes; keep the posted field name and format; keep the component free of data loading and of imports from `src/app` or `src/server`; put the date maths in the pure helper file and unit-test it.
- **Ask first:** migrating any other date field; adding any dependency, including dev-only browser test tooling committed to `package.json`; changing domain date rules or `min` semantics.
- **Never:** palette or `dark:` classes; `text-accent` for text; editing the server action, validation or schema; committing to main.

## Design (approved)

Option C, "Sentence-scale calendar" (`.agent/design/option-c.html`, chosen by Peter: "I like option C"; see `.agent/design/CHOSEN.md`). Build to match the mockup's CSS, translated to theme tokens and `styles.ts` recipes:
- **Typed field:** underline-only (bottom border `border-field-border` equivalent), caption label on the left, `YYYY-MM-DD` placeholder, error text in the danger token under it.
- **Header:** large month name in the display font (`--display-font`) with the year muted beside it; previous/next are bare, borderless, round 2.5rem icon buttons in `text-accent-ink`, grouped on the right.
- **Weekdays:** small uppercase muted abbreviations.
- **Day cells:** square (`aspect-ratio: 1`, min height 2.25rem), hover is a 10% accent tint with `text-accent-ink`.
- **Today:** a short accent-ink underline under a bold number (not colour alone).
- **Selected:** filled `bg-accent` tile with the on-accent text token, in the theme's button radius.
- **Disabled (before `min`):** muted, 50% opacity, struck-through number.
- **Footer:** a dashed top border, then a left-aligned text button "Today · Mon, Nov 9" (the date it will pick) in `text-accent-ink`.
- **Phones (under 40rem):** the popup is not anchored under the token; it renders as a panel the width of the sentence's card, with a smaller month heading (1.25rem) and less padding. The popup still obeys R12 (no horizontal scroll at 320px; cells at least 36px).
- Frost keeps its backdrop blur on the popup, as the card has it.

The mockup is a reference for look only. If it conflicts with R1–R13, the requirements win. Today marker and phone placement: Option C's own, kept (assumption; Peter did not ask for a swap).

## Resolved ambiguities

| Item | Chosen reading | Source |
|---|---|---|
| Fields in scope | Reusable `DatePicker`; only the request sentence is migrated | `.agent/answers.md` Q1 |
| Implementation | Custom popup, theme tokens, no new package | answers Q2 |
| Design reference | The screenshot shows the problem; the target is the approved option C | answers Q3, `CHOSEN.md` |
| Required details | Month nav, Monday-first, muted adjacent days, today marker, Today button, min-disabled, APG keyboard, no Clear, no year dropdown | answers Q4 |
| Theme/mode matrix | 9 themes, Classic light/dark/auto, custom accent, corner override | answers Q5 |
| Which design | Option C | `.agent/decisions.md`, `CHOSEN.md` |
| Today marker | Option C's underline (assumed) | `decisions.md` |
| Phone placement | Option C's card-width panel (assumed) | `decisions.md` |
| AC1(a) out-of-month count | 12, not 7: Nov 1, 2026 is a Sunday, so the grid opens with 6 October days and ends with 6 December days (2026-10-26 to 2026-12-06 is 42 days, 30 in November) | `.agent/design/README.md`; checked by arithmetic: 42 - 30 = 12 |
