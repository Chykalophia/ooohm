import type { Role } from "@/domain/actor";
import type { ApprovalDecision } from "@/shared/kernel/approval";

export type { ApprovalDecision } from "@/shared/kernel/approval";

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

/** Everything a rule needs to pick an approver, loaded in one place (`ApprovalContextReader`). */
export interface ApprovalContext {
  requester: ApprovalRequester;
  /** The requester's manager when set and in the same company; `null` otherwise. */
  manager: ApprovalCandidate | null;
  /** The manager of the requester's department, when it has one; `null` otherwise. */
  departmentManager: ApprovalCandidate | null;
  /** Admins of the requester's company. Inactive entries are ignored. */
  admins: readonly ApprovalCandidate[];
}

/**
 * Pluggable approval policy. v1 ships `ManagerApprovalRule`; multi-level approval is
 * out of scope, so a rule always resolves to exactly one approver.
 */
export interface ApprovalRule {
  /** @throws DomainError `no_approver` when nobody can approve the request. */
  resolve(context: ApprovalContext): ApprovalDecision;
}
