import type { Role } from "./actor";
import { DomainError } from "./errors";

/** The requester as the approval rule sees them, read fresh from the database. */
export interface ApprovalRequester {
  id: string;
  role: Role;
  canSelfApprove: boolean;
  managerId: string | null;
}

/** A person who could be routed a request. */
export interface ApprovalCandidate {
  id: string;
  isActive: boolean;
  createdAt: Date;
}

/** Everything a rule needs to pick an approver, loaded by the service in one place. */
export interface ApprovalContext {
  requester: ApprovalRequester;
  /** The requester's manager when set and in the same company; `null` otherwise. */
  manager: ApprovalCandidate | null;
  /** Admins of the requester's company. Inactive entries are ignored. */
  admins: readonly ApprovalCandidate[];
}

/**
 * Who decides a new request.
 *
 * - `auto_approve`: approved at submit time; `approverId` is recorded as the decider.
 * - `route`: stays pending until `approverId` (or a company admin) decides it.
 */
export type ApprovalDecision =
  | { kind: "auto_approve"; approverId: string }
  | { kind: "route"; approverId: string };

/**
 * Pluggable approval policy. v1 ships {@link ManagerApprovalRule}; multi-level
 * approval is out of scope, so a rule always resolves to exactly one approver.
 */
export interface ApprovalRule {
  /** @throws DomainError `no_approver` when nobody can approve the request. */
  resolve(context: ApprovalContext): ApprovalDecision;
}

/**
 * v1 approval policy, in order:
 *
 * 1. `can_self_approve` → approved immediately, decided by the requester.
 * 2. An active manager → routed to the manager.
 * 3. Otherwise an active admin other than the requester → the longest-standing one
 *    (oldest `createdAt`, then lowest id), so routing is deterministic.
 * 4. Otherwise, if the requester is an admin → routed to themself, so a company's
 *    only admin can still take time off.
 * 5. Otherwise → `no_approver`.
 */
export class ManagerApprovalRule implements ApprovalRule {
  resolve({ requester, manager, admins }: ApprovalContext): ApprovalDecision {
    if (requester.canSelfApprove) return { kind: "auto_approve", approverId: requester.id };

    if (manager && manager.isActive && manager.id !== requester.id) {
      return { kind: "route", approverId: manager.id };
    }

    const [fallback] = admins
      .filter((a) => a.isActive && a.id !== requester.id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (fallback) return { kind: "route", approverId: fallback.id };

    if (requester.role === "admin") return { kind: "route", approverId: requester.id };

    throw new DomainError("no_approver", "Nobody can approve this request. Ask an admin to set your manager.");
  }
}

/**
 * Who should decide an already-submitted pending request now, by the same rule that
 * routed it, minus self-approval: the request was submitted as someone else's
 * decision, so it is never approved by this. In order: the requester's active
 * manager, the longest-standing other active admin, the requester themself when they
 * are an admin, else `null`, which leaves the request with no assigned approver
 * (every admin still sees it in their inbox).
 *
 * Used to re-route pending requests when an admin change moves the right to decide
 * them (the approver is deactivated or demoted from admin, the requester's manager
 * changes, or someone who can take an admin's self-routed request is invited as admin,
 * promoted to admin or reactivated), and at
 * decision time to check that a stored assignment still holds (`canDecide`).
 *
 * @param context Read after the change that prompted it (inside its transaction), so
 *   it reflects who is active, who is an admin and who manages the requester now.
 */
export function reassignApprover(rule: ApprovalRule, context: ApprovalContext): string | null {
  try {
    return rule.resolve({ ...context, requester: { ...context.requester, canSelfApprove: false } }).approverId;
  } catch (err) {
    if (err instanceof DomainError && err.code === "no_approver") return null;
    throw err;
  }
}
