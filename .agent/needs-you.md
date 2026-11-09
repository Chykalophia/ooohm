# Needs You: keep or undo a shared date-validation change

resume_at: cklph Build v3 / Build

Verify passed every acceptance criterion (434/434 unit tests, 89/89 browser checks, build OK). One gap: Fix 2 changed `src/domain/calendar-date.ts`, so the server's date validation now accepts years 0001–0099. On `main` it rejects them, and year 50 is silently read as 1950. The spec said "Never: editing validation" and "Ask first: changing domain date rules". Details are in `.agent/verify.md`.

## Questions

1. **The domain date change?**
   - A: Undo it in `calendar-date.ts`. Put the `setUTCFullYear` helper in `date-picker-grid.ts` / `date-picker.tsx` only, and keep both attack tests passing. Server validation stays as on `main`. ★ recommended
   - B: Keep it, as an approved bug fix. Add unit tests for `isCalendarDate` and `toEpochDay` on years 1–99 and note the change in the PR.
   - C: Undo it, and also refuse years before 1000 in the picker (typed entry, navigation).

## For the Needs You agent

Record the answer in `.agent/decisions.md`, then route to `cklph Build v3 / Build` with the chosen option as Build's task. After Build, the card should come back through Verify.
