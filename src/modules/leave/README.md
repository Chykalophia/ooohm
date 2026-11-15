# leave

**Tier 3.** A person's time off: asking for it, booking it for someone else, cancelling or removing it, and keeping
its day count right when the company calendar changes. The rules live in an aggregate, the use cases depend on
ports, and the use-case tests run on in-memory fakes.

## Owns

The `leave_requests` table and the writes to `leave_request_days` (a request's cost per calendar year), through
`infrastructure/drizzle-leave-request.repository.ts` and `drizzle-leave-request-days.ts`. Approvals change a
request's status and approver through this module's API (`lockLeaveRequest`, `updateStatusIfCurrent`,
`reassignIfCurrent`); balances reads `leave_request_days`.

## Public API (`index.ts`)

Use cases, each `(ctx, actor, …)` → `ServiceResult`:

- `submitLeaveRequest(ctx, actor, input)` → `SubmittedLeaveDTO`: pending with the requester's approver, or approved
  at once when they may approve their own (`can_self_approve`) or approval is turned off (`headsUp`). Fails with
  `invalid_input`, `invalid_date_range`, `range_too_long`, `half_day_multi_day`, `leave_type_unavailable`,
  `zero_days`, `overlapping_request`, `insufficient_balance` (with the year, days requested and remaining),
  `forbidden` (inactive) and `rate_limited` (`SUBMIT_LIMIT` in `SUBMIT_WINDOW_MINUTES`).
- `cancelLeaveRequest(ctx, actor, requestId)` → `LeaveRequestDTO`: also `not_found`, `invalid_transition`,
  `leave_taken`, `past_year_closed` and `conflict`.
- `addLeaveFor(ctx, actor, userId, input)` → `AddedLeaveDTO`: an admin or the person's manager books approved leave
  for them.
- `removeLeaveFor(ctx, actor, requestId, reason)` → `LeaveRequestDTO`: corrects approved leave of the open year.
- `recountLeave(tx, ctx, actor, change)` → `Recount`: inside the holiday or working-days transaction, which unwraps it.

Queries: `getDashboard`, `listMyRequests`, `getMyRequest`, `previewLeaveFor`, `listLeaveRequestsForApi` (each a
`ServiceResult`), and `alsoOffFor`, `alsoOffText`, `draftCoverage` (plain values on the caller's executor).

For approvals, on its transaction: `recordLeaveChange`, `recordReassignment`, `activeContacts`, `summarize`,
`lockLeaveRequest`, `updateStatusIfCurrent`, `reassignIfCurrent`, `toLeaveRequestDTO`, `provideApprovalRouting`, and the
rules `assertTransition`, `canDecide`, `decidesByAssignment`, `normalizeNote`. Policies: `canCancel`,
`canAddLeaveFor`, `canCorrectLeaveFor`, `canSeeLeaveDetails`, `canCancelOn`, `canRemoveOn`. DTO types and the
`LeaveRequest` type; never a row.

Every change writes an audit row and a `leave.*` outbox event in its transaction (`requested`, `approved`,
`cancelled`, `recounted`), through `recordChange`, and emails after commit.

## Inside

- `domain/`: `DateRange` (`date-range.ts`), `DayCount` (`day-count.ts`), the `LeaveRequest` aggregate
  (`leave-request.ts`: `submitLeave`, `approveLeave`, `cancelLeave`, `removeLeave`, each a `ServiceResult` with
  the domain event it records), the status machine (`leave-status.ts`), `events.ts`, `errors.ts`, overlap and
  coverage sentences, permissions, notes and the recount arithmetic. Pure. The range and day-count rules other code
  shares are in `src/shared/kernel/leave-range.ts` and `leave-days.ts`.
- `application/ports.ts`: `LeaveRequestRepository`, `LeaveDirectory` (people, settings, locks), `AllowanceReader`
  (balances), `ApprovalRouter` (approval routing), `ChangeLog`, `AlsoOffReader`, `Clock`, and `LeaveDeps` with its
  `unitOfWork`.
- `application/use-cases/`: one file per use case. `application/queries/`: one file per read.
- `infrastructure/`: the Drizzle repository and directory, and the adapters onto `@/modules/balances` and
  `recordChange`.
- Approval routing (`ApprovalRouter`: `route` and `currentApprover`) is leave's port, implemented by
  `@/modules/approvals`. Leave never imports approvals: `provideApprovalRouting` takes the implementation, and
  `wireModules()` in `src/server/wiring.ts` calls it from every composition root. Reads that never route need no
  wiring.
- `composition.ts`: binds the ports to a transaction (`leaveStore`, `leaveDeps`, `leaveModule`); the index exports
  its ctx-taking functions.

## Tests

- `tests/unit/modules/leave/`: the domain (`date-range`, `day-count`, `leave-request.aggregate`, status, overlap,
  coverage), the use cases on fakes (`use-cases/`), and `events.contract.test.ts`, which pins every `leave.*` payload.
- `fakes/`: `InMemoryLeaveRequestRepository`, `FixedClock`, `RecordingAudit`, `RecordingOutbox`, the directory,
  balances, routing and also-off fakes, and `leaveKit()`, whose unit of work rolls back on a throw.
- `contracts/leave-request-repository.contract.ts`: `leaveRequestRepositoryContract`, run on the fake in
  `pnpm test` and on Drizzle in `tests/integration/modules/leave/` (both drivers).
