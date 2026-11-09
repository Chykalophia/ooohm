# Code Review

Reviewed `feature/review-date-picker-t-352` against `origin/main`. The feature unit tests cover the specified pure date calculations; the recorded browser evidence reports 89 passing checks and documents the 320px overflow exception. `git diff --check $(git merge-base HEAD origin/main)..HEAD` exited 0.

## 1. Standards

- No medium-or-higher standards findings. The date arithmetic is kept in pure helpers, UI and domain boundaries are respected, and the component uses theme tokens rather than palette colors.

## 2. Spec

- **[medium] `src/components/forms/date-picker.tsx:114-118` — AC6 remains unmet at 320px.** The browser evidence records `scrollWidth=324` both before and after opening. The picker does not add overflow, but the acceptance criterion requires the open page's scroll width to be at most 320px. Find and constrain the overflowing leave-type chip/container (or otherwise remove the page overflow) and rerun the 320px check; don't mark AC6 passed until the absolute condition is met.
- **[low] `src/components/forms/date-picker.tsx:116-118` — phone placement does not implement the approved card-width panel.** On small screens the panel is fixed to viewport width minus 2rem and its left edge is viewport x=16px, regardless of the sentence card's bounds. The approved Option C calls for a panel the width of the sentence card. Measure/use the card bounds for phone width and placement, while retaining the 320px cell-size constraint.

R1–R11 and R13 are consistent with the implementation and recorded evidence. AC1 has the requested unit assertions; AC2/AC3 and AC4/AC5/AC7 are reported passing in the handoff/evidence. AC6 is the exception above. The only migrated call site and absence of package changes match scope.

## 3. Omissions

- **[low] Browser coverage does not establish the 320px absolute no-overflow criterion.** `.agent/evidence/date-picker/checks.txt` records the failure as pre-existing. Add a regression check that identifies the overflowing element and passes only when the page is at most 320px wide with the popup open.

## Review Fix

- **[medium] AC6 320px overflow**: fixed. The `token` chip class had an unconditional `whitespace-nowrap`; it is now `sm:whitespace-nowrap`, so "PTO (Scheduled Time Off)" wraps inside its chip on phones. Regression test `tests/unit/request-sentence-chips.test.ts` (fails on the old class string).
- **[low] phone panel width**: fixed. On phones the panel now takes the nearest `section` (the sentence card) box: its left edge and width, capped at the viewport (`date-picker.tsx` placement effect). Cell sizes are unchanged.
- **[low] browser coverage**: `verify.mjs` now FAILs unless `scrollWidth <= 320` with the popup open (culprit named), and checks panel box == card box.
- Not re-run: the browser script. Its playwright/chromium setup lived under /tmp and is gone, so the 320px result is unmeasured this session; Break 1 should re-run it.
- Suite: `tsc --noEmit` clean, eslint clean on touched files, unit tests 430 pass / 0 fail. Integration tests not run (no DB change).
