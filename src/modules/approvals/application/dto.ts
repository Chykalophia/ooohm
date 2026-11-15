import "server-only";
import type { PageCursor } from "@/shared/kernel/paging";
import type { AlsoOff } from "@/modules/leave";
import type { InboxRequest, RecentDecision, ReviewRequest } from "./ports";

export type { LeaveRequestDTO } from "@/modules/leave";

/** Which tab of the Approvals page: whose move it is. */
export type ApprovalsView = "mine" | "others" | "settled";

/** A pending request on the Approvals page, with who else is off on its dates. */
export type InboxItemDTO = InboxRequest & { alsoOff: AlsoOff | null };

/** A decision on the Settled tab. */
export type SettledDecisionDTO = RecentDecision & { decision: "approved" | "rejected" };

/** One tab of the Approvals page, with both pending tabs' counts for their labels. */
export interface ApprovalTriageDTO {
  view: ApprovalsView;
  needsYouTotal: number;
  waitingTotal: number;
  settledDays: number;
  timeZone: string;
  items: InboxItemDTO[];
  settled: SettledDecisionDTO[];
  previous: PageCursor | null;
  next: PageCursor | null;
}

/** Whether the header shows the Approvals link, and how many requests wait there. */
export interface ApprovalNavDTO {
  visible: boolean;
  pending: number;
}

/** A request as the approve-from-email page shows it. */
export type ReviewRequestDTO = ReviewRequest;

/**
 * What an approve link leads to:
 * - `invalid`: not a link this app signed, or its request is gone.
 * - `expired`: older than `APPROVE_LINK_DAYS` days.
 * - `decided`: the request is no longer pending (decided, cancelled, or approved through
 *   this very link before).
 * - `not_yours`: the person the email went to can no longer decide it (it moved to
 *   another approver, even an admin's, or they were deactivated).
 * - `ready`: pending and theirs to approve.
 * - `approved`: just approved through the link.
 */
export type EmailApproval =
  | { state: "invalid" | "expired" | "not_yours" }
  | { state: "decided"; request: ReviewRequestDTO }
  | { state: "ready" | "approved"; request: ReviewRequestDTO };
