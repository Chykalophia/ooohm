# ADR-0012: CI gates every merge; boundary rules start from a recorded baseline

- **Status:** Accepted (2026-11-14, with the plan in PR #102)
- **Date:** 2026-11-15

## Context

There is no CI in the repo; Vercel deploys `main` on merge after migrate + build. The reference asks for fitness
functions that fail CI on new violations, starting from a baseline and burning it down.

## Decision

- Add GitHub Actions (`.github/workflows/ci.yml`) running typecheck, lint, dependency-cruiser, cycles, unit,
  integration on PGlite and on Postgres 16, and build with a bundle-secret grep. It is required on `main`.
- Each fitness rule ships with a baseline file (dependency-cruiser `known-violations`, ESLint suppressions, test
  allow-lists). CI fails only on new violations; every allow-list entry names the phase that removes it.
- Architecture review checklist on every PR: right layer? auth inside the action/use case? DTO returned? allowed
  dependency direction? ADR needed?

## Consequences

- Rules stop depending on someone remembering to run them.
- CI minutes on GitHub; the Postgres service container adds about a minute.
