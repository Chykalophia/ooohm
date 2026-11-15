import type { DomainErrorCode } from "@/shared/kernel/errors";

/**
 * The failures leave's rules and use cases report, each a `DomainErrorCode` with a calm
 * message in the action pipeline and an HTTP status in the API.
 */
export const LEAVE_ERROR_CODES = [
  "invalid_input",
  "invalid_date_range",
  "range_too_long",
  "half_day_multi_day",
  "zero_days",
  "overlapping_request",
  "leave_type_unavailable",
  "insufficient_balance",
  "policy_unavailable",
  "rate_limited",
  "invalid_transition",
  "past_year_closed",
  "leave_taken",
  "not_found",
  "forbidden",
  "conflict",
  "no_company",
] as const satisfies readonly DomainErrorCode[];

export type LeaveErrorCode = (typeof LEAVE_ERROR_CODES)[number];
