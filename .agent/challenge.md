# Challenge: calendar date selector

## Split

1. **Modernize the picker shown inside the leave request sentence.** This is a UI feature/redesign; the task does not specify detailed visual acceptance, so use the approved in-repo design rules and the answered interaction requirements.
2. **Make that selector theme-aware.** This is part of the redesign and independently verifiable across company themes and Classic colour modes.
3. **Potentially migrate other date fields.** This would be a separate cross-screen rollout. The answer explicitly excludes the request form, holiday and audit fields from this PR; list them as follow-up work only.

## Premise

| Ask | Assessment | Evidence |
|---|---|---|
| The existing picker works but its design should be modernized | **Holds.** The request-sentence `DateToken` overlays an invisible native date input and opens the browser picker via `showPicker()`. That native popup is controlled by the browser/OS rather than app styles (`src/app/request-leave-sentence.tsx:140-185`); the app's CSS documents that native controls follow `color-scheme` (`src/app/globals.css:20-38`). A custom popup is therefore a plausible way to deliver consistent themed UI. |
| The replacement should be on-brand in all themes | **Holds.** `AGENTS.md` requires calm UI and theme tokens; `src/components/ui/styles.ts:12-38` provides token-based focus and field recipes. Theme tokens vary by company theme and Classic colour mode (`src/app/globals.css:20-47`). |
| All date controls need modernization | **Wrong for this milestone.** The answered scope is a reusable shared client component replacing the request-sentence picker only. The request form and admin holiday/audit date controls are explicitly follow-ups (`.agent/answers.md`, Round 1, item 1); existing examples include `src/app/request-leave-form.tsx:196-205`. |

## Context

| Needed context | Status | Evidence / resolution |
|---|---|---|
| Target screen(s) | **Present** | Request sentence only, implemented by `DateToken` (`src/app/request-leave-sentence.tsx:140-188`); `.agent/answers.md`, item 1 confirms reusable component, no other field migrations. |
| Implementation boundary | **Present** | Build an in-house themed calendar popup, no new package; preserve date-only form value and typed entry. `.agent/answers.md`, item 2. |
| Design reference | **Present** | The screenshot is the current problem, not the target. Follow the calm UI and theme-token rules in `AGENTS.md`, and existing control recipes in `src/components/ui/styles.ts`; `.agent/answers.md`, item 3. |
| Required interaction | **Present** | Month label and previous/next navigation; Monday-first weekday header; selectable adjacent-month dates; today marker and Today shortcut; dates before `min` disabled; Escape/outside dismissal restores trigger focus; arrow keys, PageUp/PageDown, Home/End, Enter; fit small screens without horizontal scroll. `.agent/answers.md`, item 4. No Clear action because both dates are required. |
| Date semantics | **Present** | Keep `YYYY-MM-DD` value and required form submission; end date uses `min={startDate}` (`src/app/request-leave-sentence.tsx:169-177`; `.agent/answers.md`, item 2). |
| Theme/mode acceptance | **Present** | Every company theme, plus Classic light, dark and automatic; custom accent and corner override; tokens only, no palette classes or `dark:` variants. `.agent/answers.md`, item 5 and `AGENTS.md`. |
| Acceptance signals | **Assumed** | Validate the specified behavior, keyboard/screen-reader use, responsive fit and theme matrix in the build/verification step. These are now concrete from the round-one answers; no external design asset or new access is needed. |

## Questions

No blocking questions remain. All five SAFE questions from the previous challenge were answered in `.agent/answers.md` (Round 1); none concerns a HUMAN-ONLY decision.

## ASSUMPTIONS I'M MAKING

- The supplied screenshot refers to the request-sentence picker; this is consistent with the code and the answered scope.
- The component is reusable infrastructure, but only the request-sentence field is migrated in this milestone.
- Existing domain date validation remains authoritative; the selector only handles presentation and input interaction.
- The in-repo visual language and answered interaction checklist provide the acceptance reference without requiring a new brand decision.

## Not doing

- Not migrating the request form, holiday creation or audit filters; keep these as follow-up candidates.
- Not adding a date-picker dependency.
- Not changing date validation, leave-day counting, persistence, permissions or server behavior.
- Not adding Clear or year dropdown controls; these were not selected in the answered requirements.
