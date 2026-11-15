# ADR-0001: Adopt the SaaS Layered Architecture Reference as a modular monolith

- **Status:** Accepted (2026-11-14, with the plan in PR #102)
- **Date:** 2026-11-15
- **Deciders:** Peter (owner)

## Context

Chykalophia's *SaaS Layered Architecture Reference* (Nov 14, 2026) is now the standard for every app the agency
builds. OOOhm is already layered, but layer-first (`src/app`, `src/server/services`, `src/server/repositories`,
`src/domain`), with 46 services in one folder and 101 service-to-service imports. The reference recommends feature
modules, layered inside, as the top-level structure, and tiers chosen per module.

## Decision

We will move OOOhm to a **modular monolith**: one deployable, one module per business area under `src/modules/`,
each with `ui/`, `application/`, optional `domain/`, `infrastructure/` and a public `index.ts`.

Tiers per module: **Tier 3** for `leave`, `approvals` and `balances` (real invariants); **Tier 2** for the rest, with a
`domain/` folder where a module already has pure rules (calendar visibility, people lifecycle, holidays). No module is
Tier 1. No microservices and no Turborepo packages until there is evidence (independent scaling, ownership,
compliance isolation).

The migration follows `docs/architecture-plan/03-phased-plan.md` (phases A0–A8), behaviour unchanged, one phase per
PR series.

## Consequences

- A change to one feature touches one folder, not seven.
- Module public APIs make the existing "one place" rules (approval routing, calendar scope, allowance defaults)
  enforceable by the import graph instead of by convention.
- For a while two shapes coexist; ARCHITECTURE.md says new code goes in the target shape.
- If, after A3, lead time gets worse without fewer failures, we simplify (fewer ports, merge modules).
