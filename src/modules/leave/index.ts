import "server-only";
/**
 * The leave module's public API (see README.md). Everything outside the module imports
 * from here only. Use cases and queries that can fail return a `ServiceResult`; the
 * executor-taking helpers at the end are for other modules' transactions (approvals).
 */
export {
  leaveModule,
  submitLeaveRequest,
  cancelLeaveRequest,
  addLeaveFor,
  removeLeaveFor,
  previewLeaveFor,
  getDashboard,
  listMyRequests,
  getMyRequest,
  listLeaveRequestsForApi,
  recountLeave,
  recordLeaveChange,
  recordReassignment,
  activeContacts,
} from "./composition";
export { SUBMIT_LIMIT, SUBMIT_WINDOW_MINUTES, type SubmitLeaveInput } from "./application/use-cases/submit-leave-request";
export { NOTHING_RECOUNTED, type CalendarChange, type HolidayFact, type OverdrawnBalance, type RecountOutcome } from "./application/use-cases/recount-leave";
export { REQUESTS_PAGE_SIZE } from "./application/queries/list-my-requests";
export { DASHBOARD_REQUESTS } from "./application/queries/get-dashboard";
export type { LeaveRequestQuery, ApiLeaveRequestDTO } from "./application/queries/list-leave-requests-for-api";
export { alsoOffFor, alsoOffText, type AlsoOff, type AlsoOffRequest } from "./application/queries/also-off";
export { draftCoverage } from "./application/queries/draft-coverage";
export { summarize, type LeaveChange } from "./application/leave-changes";
export type {
  AddedLeaveDTO,
  DashboardDTO,
  DashboardRequestDTO,
  LeaveRequestDTO,
  MyRequestDTO,
  MyRequestsPageDTO,
  OwnRequestDTO,
  SubmittedLeaveDTO,
} from "./application/dto";
export type { LeaveRequest } from "./domain/leave-request";
export {
  canAddLeaveFor,
  canCancel,
  canCorrectLeaveFor,
  canDecide,
  canSeeLeaveDetails,
  decidesByAssignment,
  type PersonOwnership,
  type RequestOwnership,
} from "./domain/leave-permissions";
export { assertTransition, canCancelOn, canRemoveOn, canTransition, isLeaveOver } from "./domain/leave-status";
export { normalizeNote } from "./domain/note";
export { MAX_OFF_LIMIT } from "./domain/coverage";
