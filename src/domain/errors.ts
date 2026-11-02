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
  | "rate_limited"
  /**
   * A tracked leave type's balance cannot cover the request in some year (pending
   * requests count as spent). Carries {@link BalanceShortfallDetails}.
   */
  | "insufficient_balance"
  /**
   * The company's `allowance_policy` names no known policy. A configuration fault, not
   * a user mistake: the presentation layer logs it as well as showing a message.
   */
  | "policy_unavailable"
  /** The change would leave the company without an active admin. */
  | "last_admin"
  /**
   * Something with the same unique key already exists (an email, a department name, a
   * leave type code, a holiday date). Each action words it for what it creates.
   */
  | "already_exists"
  /** The chosen manager is not an active member of the company, or is the person themself. */
  | "invalid_manager"
  /** The chosen manager reports, directly or not, to the person: a reporting loop. */
  | "manager_cycle"
  /** A department still has people in it, so deleting it would silently move them. */
  | "department_not_empty"
  /** Admins cannot deactivate their own account; another admin has to. */
  | "self_change_not_allowed";

/**
 * Facts behind an `insufficient_balance` error, so the presentation layer can say
 * exactly what is left without parsing a message.
 */
export interface BalanceShortfallDetails {
  /** The calendar year whose balance falls short. */
  readonly year: number;
  /** Days the request costs in that year. */
  readonly requested: number;
  /** Days left in that year before this request (may be 0 or negative). */
  readonly remaining: number;
  /** How many calendar years the request spans (1 or 2). */
  readonly yearsSpanned: number;
}

/** Structured facts attached to some codes; see each code's documentation. */
export type DomainErrorDetails = BalanceShortfallDetails;

/**
 * An expected, user-correctable failure. Anything that is not a `DomainError` is a
 * bug or an infrastructure fault and must not be shown to users verbatim.
 */
export class DomainError extends Error {
  readonly code: DomainErrorCode;
  /** Structured facts for wording the user message; present for `insufficient_balance`. */
  readonly details?: DomainErrorDetails;

  constructor(code: DomainErrorCode, message?: string, details?: DomainErrorDetails) {
    super(message ?? code);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

/** Narrowing helper for `catch` blocks, optionally matching a specific code. */
export function isDomainError(err: unknown, code?: DomainErrorCode): err is DomainError {
  return err instanceof DomainError && (code === undefined || err.code === code);
}
