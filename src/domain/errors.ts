/**
 * Stable error codes raised by the domain and service layers.
 *
 * Codes are part of the contract with the presentation layer, which maps each one
 * to a calm, user-facing message (or an HTTP status). Add codes; never repurpose one.
 */
export type DomainErrorCode =
  /** Input failed validation (bad format, too long, missing field). */
  | "invalid_input"
  /** The signed-in user does not belong to a company yet. */
  | "no_company"
  /** End date is before start date. */
  | "invalid_date_range"
  /** The date range is longer than a single request may cover. */
  | "range_too_long"
  /** A half day (am/pm) was requested across more than one day. */
  | "half_day_multi_day"
  /** The range contains no working days once weekends and holidays are removed. */
  | "zero_days"
  /** The leave type does not exist in this company or is archived. */
  | "leave_type_unavailable"
  /** The range overlaps one of the requester's pending or approved requests. */
  | "overlapping_request"
  /** No eligible approver exists for the requester. */
  | "no_approver"
  /** The record does not exist or is not visible to the actor. */
  | "not_found"
  /** The actor is not allowed to perform this action. */
  | "forbidden"
  /** The requested status change is not allowed by the state machine. */
  | "invalid_transition"
  /** The record changed underneath the caller (e.g. a concurrent decision won). */
  | "conflict"
  /** The actor did this too often in a short window; they can retry later. */
  | "rate_limited";

/**
 * An expected, user-correctable failure. Anything that is not a `DomainError` is a
 * bug or an infrastructure fault and must not be shown to users verbatim.
 */
export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message?: string) {
    super(message ?? code);
    this.name = "DomainError";
    this.code = code;
  }
}

/** Narrowing helper for `catch` blocks, optionally matching a specific code. */
export function isDomainError(err: unknown, code?: DomainErrorCode): err is DomainError {
  return err instanceof DomainError && (code === undefined || err.code === code);
}
