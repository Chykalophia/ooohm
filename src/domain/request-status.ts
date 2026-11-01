import { DomainError } from "./errors";
import type { LeaveStatus } from "./leave-request";

/**
 * The leave request state machine. Rejected and cancelled are terminal; an approved
 * request can still be cancelled (plans change), but never rejected after the fact.
 */
const TRANSITIONS: Readonly<Record<LeaveStatus, readonly LeaveStatus[]>> = {
  pending: ["approved", "rejected", "cancelled"],
  approved: ["cancelled"],
  rejected: [],
  cancelled: [],
};

export function canTransition(from: LeaveStatus, to: LeaveStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** @throws DomainError `invalid_transition` when `from -> to` is not allowed. */
export function assertTransition(from: LeaveStatus, to: LeaveStatus): void {
  if (!canTransition(from, to)) {
    throw new DomainError("invalid_transition", `A ${from} request cannot become ${to}.`);
  }
}

/** Statuses from which a request can be cancelled. */
export function isCancellable(status: LeaveStatus): boolean {
  return canTransition(status, "cancelled");
}
