import "server-only";
/**
 * The approvals module's public API (see README.md). Everything outside the module
 * imports from here only. The executor-taking helpers are for other services'
 * transactions (admin changes that re-route, the TimeOff import).
 */
export {
  decideLeaveRequest,
  setDepartmentManager,
  getApprovalTriage,
  getApprovalNav,
  readEmailApproval,
  approveFromEmail,
  approveLinkFor,
  rerouteApprovals,
  loadApprovalContexts,
  listPendingAssignedTo,
  listPendingRequestsOf,
  listPendingRequestsInDepartment,
  listPendingSelfRouted,
  leaveApprovalRouting,
} from "./composition";
export type { Decision, DecideInput } from "./application/use-cases/decide-leave-request";
export type { DepartmentManagerResult } from "./application/use-cases/set-department-manager";
export { INBOX_PAGE_SIZE, SETTLED_DAYS } from "./application/queries/get-approval-triage";
export type { Rerouted } from "./application/reroute-pending";
export type { RoutingRequester } from "./application/ports";
export type {
  ApprovalNavDTO,
  ApprovalsView,
  ApprovalTriageDTO,
  EmailApproval,
  InboxItemDTO,
  LeaveRequestDTO,
  ReviewRequestDTO,
  SettledDecisionDTO,
} from "./application/dto";
export type { ApprovalCandidate, ApprovalContext, ApprovalRequester, ApprovalRule } from "./domain/approval-context";
export { approvalRuleFor, HeadsUpApprovalRule } from "./domain/approval-rule";
export { approverFor, ManagerApprovalRule, reassignApprover } from "./domain/approver-for";
