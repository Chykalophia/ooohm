/**
 * The approval words leave, approvals and the company settings share: how a company
 * treats time off, and what the approval rule decides for a new request. The rules
 * themselves are in `src/modules/approvals/domain`.
 */

/**
 * How a company treats time off, chosen by an admin for everyone (Admin → Company):
 *
 * - `required`: people ask, and an approver decides (`ManagerApprovalRule`).
 * - `heads_up`: people tell. Time off is booked as it is sent, and the person who would
 *   have decided it is told instead (`HeadsUpApprovalRule`).
 *
 * Stored on the company, which is the tenant every rule is scoped to, so it moves with
 * the company should several share one deployment.
 */
export const APPROVAL_MODES = ["required", "heads_up"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "required";

export function isApprovalMode(value: string): value is ApprovalMode {
  return (APPROVAL_MODES as readonly string[]).includes(value);
}

/** A stored mode, read safely: anything unknown asks for approval, the cautious default. */
export function readApprovalMode(value: string): ApprovalMode {
  return isApprovalMode(value) ? value : DEFAULT_APPROVAL_MODE;
}

/**
 * Who decides a new request.
 *
 * - `auto_approve`: approved at submit time; `approverId` is recorded as the decider.
 * - `route`: stays pending until `approverId` (or a company admin) decides it.
 */
export type ApprovalDecision =
  | {
      kind: "auto_approve";
      approverId: string;
      /**
       * Someone to tell about the booked time off, without asking them anything
       * (heads-up mode), or `null` when there is nobody. Absent: nobody is told.
       */
      informId?: string | null;
    }
  | { kind: "route"; approverId: string };
