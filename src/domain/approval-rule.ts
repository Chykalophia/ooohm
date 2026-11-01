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
