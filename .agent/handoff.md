return_to: cklph Build v3 / Spec Revise
needs_you: .agent/needs-you.md
resume_at: cklph Build v3 / Spec Revise

## Build (2026-11-09)
- Slices 1-3 committed: `src/components/forms/date-picker-grid.ts`, `src/components/forms/date-picker.tsx`, `DateToken` in `src/app/request-leave-sentence.tsx`, `tests/unit/date-picker-grid.test.ts`.
- Gates this session: typecheck exit 0; lint exit 0 (1 pre-existing warning in site/app.js); `pnpm test` 429/429 pass; `pnpm build` exit 0.
- Browser: `.agent/evidence/date-picker/checks.txt` (88 PASS, 0 FAIL, 1 KNOWN); README there explains method and the KNOWN.
- KNOWN: 320px page overflow (324px) is pre-existing, from the leave-type ChipSelect, present with the picker closed.
- Slice 5 (PR body "Not doing" + assumptions) is for whoever opens the PR; no PR opened here.
