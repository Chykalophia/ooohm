# approvals

**Tier 3.** Who decides a request and the deciding itself: one approver per person (their manager, else their
department's manager, else the longest-standing other admin), self-approval, the Approvals page, approving from
the request email with a signed link, and re-routing pending requests when an admin change moves the right to
decide them. The rules are pure, the use cases depend on ports, and the use-case tests run on in-memory fakes.

## Owns

No table of its own. Leave owns `leave_requests`, so a decision or a reassignment writes through leave's public
API (`lockLeaveRequest`, `updateStatusIfCurrent`, `reassignIfCurrent`, `recordLeaveChange`, `recordReassignment`),
which records the audit row and the `leave.approved`, `leave.rejected` or `leave.reassigned` event in the same
transaction. Approvals owns its reads: the routing loader, the inbox and Settled, the review an approve link shows,
and the pending lists an admin change re-routes.

## Public API (`index.ts`)

- `decideLeaveRequest(ctx, actor, { requestId, decision, reason?, assignedTo? })` → `ServiceResult<LeaveRequestDTO>`:
  approve or reject, by the assigned approver the rule still picks, or by an admin. A reason is optional. Fails with
  `invalid_input`, `not_found`, `forbidden`, `invalid_transition` and `conflict`.
- `approveFromEmail(ctx, token)` → `ServiceResult<EmailApproval>` and `readEmailApproval(ctx, token)` →
  `EmailApproval`: the signed link must be valid and unexpired, and its approver active and still assigned.
  Reading never decides (mail scanners open links). `approveLinkFor(ctx, requestId, approverId)` signs one.
- `getApprovalTriage(ctx, actor, { view, page, size })` → `ApprovalTriageDTO` (Needs you, Waiting on others,
  Settled) and `getApprovalNav(ctx, actor)` → `ApprovalNavDTO`.
- `setDepartmentManager(ctx, actor, id, managerId)` → `ServiceResult<DepartmentManagerResult>`: organisation's
  `changeDepartmentManager` step and the re-route of the department's pending requests, in one transaction. Fails
  with `forbidden`, `not_found`, `no_company` and `invalid_manager`.
- On another module's transaction: `rerouteApprovals(ctx, tx, actor, requests)` → `{ reassigned, notify }`,
  `loadApprovalContexts(ex, companyId, requesters)` (the TimeOff import), and the pending lists
  `listPendingAssignedTo`, `listPendingRequestsOf`, `listPendingRequestsInDepartment`, `listPendingSelfRouted`.
- The rules: `ManagerApprovalRule`, `HeadsUpApprovalRule`, `approvalRuleFor`, `reassignApprover`, `approverFor`.
  The approval modes and `ApprovalDecision`, which leave and organisation share, are in
  `src/shared/kernel/approval.ts`.
- `leaveApprovalRouting`: leave's `ApprovalRouter` port, implemented here.

## Dependency direction

Approvals depends on leave (its request rules, writes and change log), on organisation (department managers and
leave type names) and on notifications. Leave never imports approvals: it owns the `ApprovalRouter` port, and
`wireModules()` in `src/server/wiring.ts` hands it `leaveApprovalRouting` through `provideApprovalRouting`. Every
composition root calls it: `src/server/runtime.ts`, `scripts/script-context.mts`, the integration harness and the
e2e scripts. An import from leave to approvals would be a cycle, since approvals imports leave's index.

## Inside

- `domain/`: `approval-context.ts` (what the rule reads), `approver-for.ts` (`ManagerApprovalRule`,
  `reassignApprover`, `approverFor`) and `approval-rule.ts` (heads-up mode, `approvalRuleFor`). Pure.
- `application/ports.ts`: `ApprovalContextReader` (the one routing loader), `ApprovalRequests`,
  `ApprovalDirectory`, `ApprovalChangeLog`, `ApprovalInbox`, and `ApprovalDeps` with its `unitOfWork`.
- `application/use-cases/`: `decide-leave-request.ts`, `approve-from-email.ts`. `application/queries/`: the triage,
  the nav and reading a link. `reroute-pending.ts` is a step other use cases run on their transaction;
  `routing.ts` answers who decides for leave's port and for a decision.
- `infrastructure/`: `drizzle-approval-context.reader.ts` (`loadApprovalContexts`), the inbox and pending reads,
  the directory, and `leave-adapters.ts` onto leave's API.
- `composition.ts`: binds the ports (`approvalStore`, `approvalDeps`) and exports the ctx-taking functions.

## Tests

- `tests/unit/modules/approvals/`: `approver-for.test.ts` and `approval-rule.test.ts` (the rules),
  `use-cases/decide-leave-request.test.ts` (who may decide, reasons, approve from the email) and
  `use-cases/reroute-pending.test.ts` (approver deactivated or demoted, manager changed, a new admin taking an
  admin's own request), on the fakes in `fakes/ports.ts`.
- `contracts/approval-context-reader.contract.ts`: run on the fake in `pnpm test` and on Drizzle in
  `tests/integration/modules/approvals/` (both drivers).
- The integration suites `approvals`, `department-managers`, `email-approval` and `heads-up` cover the module end to end.
