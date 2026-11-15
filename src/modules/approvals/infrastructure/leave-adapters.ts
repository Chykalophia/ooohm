import "server-only";
/**
 * Approvals' ports that leave serves: leave owns the `leave_requests` table and the
 * leave audit and events, so a decision or a reassignment writes through leave's
 * public API. The review read is approvals' own query.
 */
import type { Executor, Transaction } from "@/db/types";
import { lockLeaveRequest, reassignIfCurrent, recordLeaveChange, recordReassignment, updateStatusIfCurrent } from "@/modules/leave";
import type { ApprovalChangeLog, ApprovalRequests } from "../application/ports";
import { findRequestForReview } from "./drizzle-approval-inbox";

/** The {@link ApprovalRequests} port, bound to `ex`. Locking needs a transaction. */
export function leaveApprovalRequests(ex: Executor): ApprovalRequests {
  return {
    lock: (companyId, id) => lockLeaveRequest(ex as Transaction, companyId, id),
    decideIfCurrent: (where, set) => updateStatusIfCurrent(ex, where, set),
    reassignIfCurrent: (where, approverId) => reassignIfCurrent(ex, where, approverId),
    findForReview: (companyId, id) => findRequestForReview(ex, companyId, id),
  };
}

/** The {@link ApprovalChangeLog} port, writing in `tx`. */
export function leaveApprovalChangeLog(tx: Transaction): ApprovalChangeLog {
  return {
    decision: (change) => recordLeaveChange(tx, change),
    reassignment: (change) => recordReassignment(tx, change),
  };
}
