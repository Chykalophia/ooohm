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

/** Whether the status machine allows `from` → `to` (see the diagram in docs/architecture.md). */
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

/** What the past-year rule needs to know about a request. */
export interface CancelFacts {
  status: LeaveStatus;
  /** Last day of the leave, `YYYY-MM-DD`. */
  endDate: string;
}

/**
 * Whether `request` is approved leave of a closed year: it ended before January 1 of
 * the year `today` falls in (`today` in the company's time zone). Such leave has been
 * taken and its year's balances are settled (and carried over), so nobody may cancel it,
 * neither the requester nor an admin; an admin corrects that year with a balance
 * adjustment instead.
 *
 * A request spanning New Year counts by its end date: Dec 29 to Jan 2 can still be
 * cancelled in the new year, since part of it falls in the year still open. A pending
 * request is never closed by this rule: it was never granted, so withdrawing it changes
 * no settled balance.
 */
export function isClosedYearLeave(request: CancelFacts, today: string): boolean {
  return request.status === "approved" && request.endDate < `${today.slice(0, 4)}-01-01`;
}

/** Whether the status machine and the past-year rule both allow cancelling `request` today. */
export function canCancelOn(request: CancelFacts, today: string): boolean {
  return isCancellable(request.status) && !isClosedYearLeave(request, today);
}

/**
 * @throws DomainError `invalid_transition` (already rejected or cancelled), or
 *   `past_year_closed` (approved leave of a closed year; see {@link isClosedYearLeave}).
 */
export function assertCancellableOn(request: CancelFacts, today: string): void {
  assertTransition(request.status, "cancelled");
  if (isClosedYearLeave(request, today)) {
    throw new DomainError("past_year_closed", "Approved leave from a past year cannot be cancelled. Adjust that year's balance instead.");
  }
}
