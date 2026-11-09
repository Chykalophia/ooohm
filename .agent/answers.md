# Answers

## Round 1 (agent research)

Source: open questions in `.agent/challenge.md` (return_to: cklph Build v3 / Challenge). All 5 classed SAFE; none on the HUMAN-ONLY list. No new dependency, no data/schema/auth change.

1. **Which fields are in scope?**
   -> **A, built as a reusable component.** Replace the request-sentence picker (`DateToken`) with the new picker, and build it as a shared client component in `src/components/forms/` (or `ui/`) so other fields can use it later. Do not migrate the request form, holiday or audit fields in this PR. Leave a "Not doing" note listing them as follow-ups.
   -> Evidence: the screenshot is the popup opened by `showPicker()` in `src/app/request-leave-sentence.tsx:141-185`. AGENTS.md says to keep each PR to one scope, and growing scope beyond the ask is HUMAN-only, so the smallest reading wins. Other `type="date"` uses: `src/app/request-leave-form.tsx:196-205`, `src/app/admin/holidays/page.tsx:39`, `src/app/admin/audit/page.tsx:204-205`.
   -> Confidence: medium. The task's wording ("the date picker") points at the one shown.

2. **Implementation boundary?**
   -> **B: a custom calendar popup styled with theme tokens. No new package.**
   -> Evidence: CSS can't style a native date input's popup. Only the field and `color-scheme` can be changed (see `src/app/globals.css` header comment: "native controls stay light"), so A cannot meet "on-brand in all themes." C adds a dependency, and `package.json:23-44` has no UI or date libraries, so a package would be off-pattern. The repo already has a hand-built month grid (`src/app/calendar/month-grid.tsx`: Monday-first `WEEKDAYS`, muted adjacent-month days, `fieldClass`/`subtleButton` recipes) and date helpers (`src/domain/calendar-date.ts`, `src/domain/calendar.ts`) to reuse.
   -> Keep: a hidden or real `<input name=... value=YYYY-MM-DD required>` so form posts and validation don't change. Keep typed entry for keyboard and screen-reader users. Honour `min` (end date >= start date).
   -> Confidence: high.

3. **Authoritative design reference?**
   -> **B: the screenshot shows the problem (the browser's native popup), not the target design.** The visual reference is the app itself: AGENTS.md "UI stays calm" rules, theme tokens, the `styles.ts` recipes, and the existing month grid's day styling. The screenshot only sets the minimum features (Q4).
   -> Evidence: the task calls the shown picker dated or off-brand, so copying it would defeat the ask. AGENTS.md:9-10 (calm UI, theme tokens, `text-accent-ink`) and `src/components/ui/styles.ts` (lint-enforced recipes).
   -> Confidence: medium.

4. **Required details?**
   -> Month label with previous/next month buttons. A Monday-first weekday header (matches month-grid). Adjacent-month days shown in `text-muted` and still selectable. Today marked. A "Today" shortcut. Dates before `min` are disabled. Esc or a click outside closes the popup and returns focus to the trigger. Grid keyboard: arrow keys, PageUp/PageDown for months, Home/End, Enter to pick (WAI-ARIA APG date picker dialog pattern, https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/examples/datepicker-dialog/). **No "Clear":** both sentence dates are `required` (`request-leave-sentence.tsx` `required`), so clearing has no valid end state. No year dropdown: leave is booked near-term, and paging months is enough. On small screens the popup must fit the viewport without horizontal scroll.
   -> Confidence: medium.

5. **Theme/mode matrix?**
   -> **A: every company theme, plus Classic in light, dark and automatic.** Use only tokens (`bg-surface`, `border-border`, `bg-accent`, `text-accent-ink`), no palette or `dark:` classes (lint enforces this). Also check a custom accent and the corner override (`data-corners`).
   -> Evidence: AGENTS.md:9-10 and the src/components rules. `src/app/globals.css` themes keyed on `[data-ui]`, `light-dark()`.
   -> Confidence: high.

Answered by agent: 5 of 5. HUMAN questions left: 0.
- Date picker design: Option C (Sentence-scale calendar). Today marker and phone placement: keep option C's own (assumed). Peter, 2026-11-09
