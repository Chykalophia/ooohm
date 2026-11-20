# ADR-0008: Server Components read; no client data library for now

- **Status:** Proposed
- **Date:** 2026-11-15

## Context

The reference puts interactive client data behind hooks (TanStack Query) in `modules/<f>/ui/`. OOOhm reads in
Server Components and mutates through server actions; there is exactly one client-side fetch (the leave request's
live preview, `GET /api/leave-preview`).

## Decision

We will not add TanStack Query. The preview fetch moves into a `useLeavePreview` hook in `modules/leave/ui/`, which is
the pattern for any future interactive read. A second interactive read that needs caching or optimistic updates
triggers a new ADR.

## Consequences

- No new dependency or bundle weight; pages stay server-rendered.
