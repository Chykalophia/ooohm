# Task challenge: calendar date selector

## Split

1. **Modernize the calendar picker interaction and appearance.** This is a feature/redesign request; “2026+ modern design” does not define the desired interaction or the visual acceptance bar.
2. **Make the selector work across every company theme and supported colour mode.** This is a theming requirement attached to the redesign. It implies theme-token work and likely requires replacing the native popup, whose chrome is owned by the browser/OS. This is coupled to ask 1, but is independently testable.
3. **Possibly modernize all date-entry controls.** The task says “cal date selector experience” and gives a calendar popup image, but does not say whether it targets the request form alone or every date field. This may expand into multiple screens and controls; resolve before implementation.

## Premise

| Ask | Assessment | Evidence and reasoning |
|---|---|---|
| Replace the displayed picker with a more current calendar experience | **Holds, with scope ambiguity.** The screenshot resembles a native browser date popup and the request leave sentence explicitly opens the browser picker. `src/app/request-leave-sentence.tsx:141-165` describes the invisible native input and calls `showPicker()`; `:169-185` renders `type="date"`. Native popup appearance varies by browser and operating system, so application theme CSS cannot reliably deliver a uniform popup. The reported functional-but-dated premise is plausible for the shown control, but no usability defect or desired design is specified. |
| Make it on-brand in all themes | **Holds.** `AGENTS.md:9-10,47` requires calm screens, theme tokens, and all themes; `docs/architecture.md:82-90` defines theme and per-person colour-mode behavior. `src/app/globals.css:20-47` documents that native controls follow `color-scheme`, while app tokens provide the theme surface, border, and text colors. Styling the existing native popup may be insufficient to satisfy the stated consistency. |
| Apply the change across date entry everywhere | **Doubtful / unstated.** Other native date controls exist: request form `src/app/request-leave-form.tsx:196-205`, holiday creation `src/app/admin/holidays/page.tsx:39`, and audit filters `src/app/admin/audit/page.tsx:204-205`. The task’s singular “cal date selector” and one screenshot do not establish that these should all change. |

No `STATE.md` or recorded decision file was found at the repository root (the attempted existence check found none). The architecture and agent rules support theme tokens, but do not prescribe a custom calendar component or picker behavior. Existing `type="date"` inputs are the simplest robust solution today; a custom picker would be a deliberate new UI component, not a small CSS correction to the native popup.

## Context

| Needed context | Status | Evidence / resolution |
|---|---|---|
| Target screen(s) | **Missing** | Request sentence is the picker shown (`src/app/request-leave-sentence.tsx:95-98,141-185`); standard leave form and admin screens also use date inputs (`src/app/request-leave-form.tsx:196-205`; holiday and audit references above). |
| Theme and colour-mode requirements | **Present** | `AGENTS.md:9-10,47`; `docs/architecture.md:82-90`; tokens are defined in `src/app/globals.css:20-47`. “All themes” should mean every company theme, plus light/dark/automatic where supported. |
| Existing design decision | **Present in code, no separate decision located** | The request sentence intentionally puts an invisible native input over readable date text; its comments explain keyboard/screen-reader typing and native picker invocation (`src/app/request-leave-sentence.tsx:140-185`). Do not assume this layout itself should be discarded. |
| Date/range behavior | **Present** | End date is constrained by start date (`src/app/request-leave-sentence.tsx:97`; `src/app/request-leave-form.tsx:197-204`); request draft logic is shared by both layouts (`src/app/request-leave-sentence.tsx:10,51-74`). |
| Desired interaction/design | **Missing** | Screenshot shows month/year heading, month navigation, weekday/date grid, selected/today states, adjacent-month dates, Clear and Today. No decision says which of these behaviors to retain or how month/year navigation, dismissal, or small-screen placement should work. |
| Accessibility/keyboard behavior | **Present as a constraint, acceptance detail missing** | Existing date token explicitly preserves keyboard entry and accessible labeling (`src/app/request-leave-sentence.tsx:141-143,169-185`). No custom picker keyboard/focus acceptance signals are given. |
| Data, access, and date semantics | **Present / no special access needed** | Current controls use date-only values (`value`, `min`) and existing form actions; the request does not ask to change persistence or date rules. No external data is needed for the shown grid. |
| Acceptance signals | **Missing** | “Functional”, “2026+ modern”, and “onbrand” do not define browser coverage, tested themes, responsive behavior, accessibility checks, or whether all date fields are in scope. |

## Questions

1. **Which fields are in scope?** A) Request sentence picker only (recommended by the screenshot); B) both leave-request layouts; C) every native date input, including holiday and audit filters.
2. **What is the intended implementation boundary?** A) Keep native date controls and improve only what browsers allow; B) build a themed custom calendar popup for consistent appearance; C) use a maintained date-picker package. This choice determines accessibility, maintenance, and browser-consistency work.
3. **What design reference is authoritative?** A) The supplied screenshot is the target behavior and rough layout; B) it is only an example of the current problem; C) provide a design/Figma reference. “Modern” alone is not an acceptance criterion.
4. **Which theme/mode combinations must be accepted?** A) Every company theme, with Classic light/dark/automatic; B) only Classic in light and dark; C) another explicit matrix. AGENTS.md requires broad theme compatibility for UI changes.
5. **Should month/year navigation and selection follow the screenshot exactly, including Clear, Today, and adjacent-month dates?** A) Yes; B) keep current platform behavior; C) define a different behavior.

## ASSUMPTIONS I'M MAKING: ...

- The supplied screenshot identifies the browser-native popup currently opened from the request sentence; this is supported by the `showPicker()` implementation, but the pictured browser itself is not identified.
- A replacement must preserve date-only form values, the end-date minimum, and keyboard/screen-reader access.
- “Onbrand” means the existing theme tokens and calm UI rules in AGENTS.md, not a new brand palette or company-wide design-system change.

## Not doing

- Not prescribing a custom implementation or visual design without answers to the scope and reference questions.
- Not changing date validation, leave-day counting, persistence, or server behavior; the request gives no evidence those are faulty.
- Not assuming every `type="date"` field should be migrated from the screenshot of one picker.
