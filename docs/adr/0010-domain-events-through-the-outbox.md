# ADR-0010: Domain events are raised by aggregates and delivered through events_outbox

- **Status:** Proposed
- **Date:** 2026-11-15

## Context

OOOhm already writes an `audit_log` row and an `events_outbox` row in the same transaction as every state change
(`recordChange`), and the worker delivers events to webhooks and adapters. The reference's Tier 3 asks for domain
events raised by the domain and an outbox for delivery.

## Decision

In Tier 3 modules the aggregate function returns the new state **and** the events it raised
(`{ request, events: [LeaveRequested, LeaveApproved] }`). The use case writes state, audit and outbox rows in one unit
of work (`inTransaction`). Every outbox write, Tier 2 or Tier 3, goes through `recordChange` (or a successor in
`shared/lib` that keeps the same contract): it is what marks the transaction (`wroteOutboxEvents`) so that
`inTransaction` / `commitThenNotify` wake the background tick after commit. A raw insert into `events_outbox` would
skip that wake and the event would wait for the next scheduled tick, so the Tier 3 outbox port's Drizzle
implementation calls `recordChange`, and an integration test asserts the inline wake fires for a Tier 3 use case.
Tier 2 modules keep calling `recordChange` directly. Event payloads remain a public
contract (`docs/api.md`): add fields, never rename or remove; contract tests pin them.

## Consequences

- "Which events does submitting leave raise?" is answered by a pure unit test.
- No change to delivery, retries or payloads.
