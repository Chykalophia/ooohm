import "server-only";
import type { Executor } from "@/db/types";
import { currentApprover, loadApprovalContext } from "@/server/services/approval-routing";
import type { ApprovalRouter } from "../application/ports";

/** Leave's {@link ApprovalRouter}, served by approval routing, bound to `ex`. */
export function approvalsRouter(ex: Executor): ApprovalRouter {
  return {
    contextFor: (companyId, requester) => loadApprovalContext(ex, companyId, requester),
    currentApprover: (companyId, requesterId) => currentApprover(ex, companyId, requesterId),
  };
}
