# Challenge: calendar date selector

## Split

1. **Modernize the calendar picker interaction and appearance.** This is a feature/redesign request; “2026+ modern design” does not define an interaction or visual acceptance bar.
2. **Make the selector work across company themes and supported colour modes.** This is a theming requirement attached to the redesign. It is independently testable, but choosing a custom selector may be necessary because native popup chrome varies by browser and OS.
3. **Possibly modernize every date-entry control.** “Cal date selector experience” and the singular picker screenshot do not establish whether only the request sentence or all date fields are in scope; expanding could affect several screens.

## Premise

| Ask | Assessment | Evidence |
|---|---|---|
| Replace the shown picker with a more current experience | **Holds, scope unclear.** `src/app/request-leave-sentence.tsx:141-185` overlays an invisible native date input and calls `showPicker()`. Native popup appearance varies by browser and OS, so application CSS cannot ensure a uniform themed popup. The “dated” premise is plausible for the shown control; no usability defect is specified. |
| Make it on-brand in all themes | **Holds.** `AGENTS.md:9-10,47` requires theme tokens and theme compatibility; `docs/architecture.md:82-90` describes company themes and per-person colour modes. `src/app/globals.css:20-47` documents native control `color-scheme` and application theme tokens. |
| Apply changes to every date field | **Doubtful / unstated.** Other native date fields are in `src/app/request-leave-form.tsx:196-205`, `src/app/admin/holidays/page.tsx:39`, and `src/app/admin/audit/page.tsx:204-205`. One screenshot does not establish that these controls should change too. |

## Context

| Needed context | Status | Evidence / resolution |
|---|---|---|
| Target screen(s) | **Missing** | Request sentence is the shown picker (`src/app/request-leave-sentence.tsx:141-185`); request form, holiday creation, and audit filters also use date fields (references above). |
| Theme/mode requirements | **Present** | `AGENTS.md:9-10,47`; `docs/architecture.md:82-90`; tokens in `src/app/globals.css:20-47`. Interpret “all themes” as every company theme and Classic light/dark/automatic where supported. |
| Existing interaction | **Present** | The sentence picker preserves native keyboard entry and accessibility while invoking the native picker (`src/app/request-leave-sentence.tsx:140-185`). Both request layouts share request draft logic; end date is bounded by start date (`src/app/request-leave-sentence.tsx:97`; `src/app/request-leave-form.tsx:197-204`). |
| Desired design and behavior | **Missing** | No acceptance decision defines month/year navigation, dismissal, small-screen placement, or whether screenshot details (Clear, Today, adjacent-month days) must remain. |
| Date/data semantics and access | **Present** | Current controls use date-only values and constraints. No persistence, permissions, or server changes are requested. |
| Accessibility acceptance | **Partly present** | Existing keyboard entry and accessible labeling are documented in the sentence picker (`src/app/request-leave-sentence.tsx:141-143,169-185`); custom picker focus and keyboard acceptance are unspecified. |
| Acceptance signals | **Missing** | “Functional”, “modern”, and “onbrand” do not specify browser coverage, tested themes, responsive behavior, or scope across fields. |
| Answers / prior decisions | **Missing** | No `.agent/answers.md` exists. No separate design decision file was found in the repository root. |

## Questions

1. **Which fields are in scope? (SAFE)** A) Request sentence picker only (★ recommended by the screenshot); B) both leave-request layouts; C) every date field, including holiday and audit filters.
2. **What implementation boundary should define consistent appearance? (SAFE)** A) Keep native controls and improve only browser-supported styling; B) build a themed custom calendar popup (★ recommended if consistent cross-browser appearance is required); C) use a maintained date-picker package.
3. **What is the authoritative design reference? (SAFE)** A) Supplied screenshot defines behavior and rough layout (★ recommended as the only concrete reference); B) screenshot only illustrates the current problem; C) provide an approved design/Figma reference.
4. **Which screenshot details should be required? (SAFE)** A) Month/year navigation, Clear, Today, and adjacent-month dates (★ recommended if screenshot is authoritative); B) retain platform behavior; C) specify different details.
5. **Which theme/mode matrix is the acceptance target? (SAFE)** A) Every company theme, with Classic light/dark/automatic (★ recommended; follows `AGENTS.md`); B) Classic light and dark only; C) another explicit matrix.

No HUMAN-only question is required: this request does not alter auth, permissions, data/schema contracts, legal/privacy matters, money, production, or a new paid vendor.

## ASSUMPTIONS I'M MAKING

- The screenshot depicts the browser-native popup opened by the request sentence; code evidence supports the implementation, but does not identify the browser shown.
- Any replacement preserves date-only values, end-date minimum constraints, and keyboard/screen-reader access.
- “Onbrand” means existing theme tokens and calm UI rules in `AGENTS.md`, with no new brand palette.
- Choices are reversible design scope decisions on the feature branch; no data or server behavior change is implied.

## Not doing

- Not prescribing custom UI details or implementation before resolving scope and reference.
- Not changing date validation, leave-day counting, persistence, or server behavior; there is no evidence these are faulty.
- Not assuming every `type="date"` control should be migrated based on one screenshot.
