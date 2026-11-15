# ADR-0009: Module template, public API, and one Drizzle schema

- **Status:** Proposed
- **Date:** 2026-11-15

## Context

Modules need a fixed shape so that agents and people put code in the same place. drizzle-kit generates migrations
from `src/db/schema.ts`, and several modules join the same tables.

## Decision

- Template: `src/modules/<m>/{ui, application/{use-cases, queries, policies.ts, dto.ts, schemas.ts, ports.ts},
  domain, infrastructure, index.ts, README.md}`. Folders are created only when needed.
- `index.ts` exports use cases, queries, DTO types and policies. It never exports a repository, a Drizzle row type or
  anything from `infrastructure/`.
- Other code imports `@/modules/<m>` only (dependency-cruiser F9). A module may depend on another module's public API;
  the module graph must stay acyclic.
- `src/db/schema.ts` stays one file. Each module's `infrastructure/` lists the tables it owns in its README; writes to
  a table happen only in its owning module.
- Shared code used by three or more modules goes in `src/shared/` (kernel types and rules in `shared/kernel`,
  utilities in `shared/lib`, the UI kit in `shared/ui`).

## Consequences

- One file per use case keeps files small and makes ownership obvious.
- A single schema keeps migrations simple; splitting it later doesn't change SQL.
