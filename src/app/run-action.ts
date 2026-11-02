import "server-only";
import type { DomainErrorCode } from "@/domain/errors";
import { isDomainError } from "@/domain/errors";
import { log } from "@/lib/log";
import type { FormState } from "./form-state";

/** What people see for each expected failure. Calm, specific, and never technical. */
const MESSAGES: Record<DomainErrorCode, string> = {
  invalid_input: "Some details aren't valid. Check the form and try again.",
  no_company: "Your account isn't part of a company yet. Ask an admin to finish setting it up.",
  invalid_date_range: "The end date is before the start date.",
  range_too_long: "That's more than a year. Pick a shorter range.",
  half_day_multi_day: "Half days work for a single date only.",
  zero_days: "Those dates are all weekends or holidays, so there's nothing to request.",
  leave_type_unavailable: "That leave type isn't available any more. Pick another one.",
  overlapping_request: "You already have time off on some of those dates.",
  no_approver: "There's nobody to approve this yet. Ask an admin to set your manager.",
  not_found: "That request doesn't exist any more.",
  forbidden: "You can't change that request.",
  invalid_transition: "That request has already been decided or cancelled.",
  conflict: "Someone else just updated that request. Refresh to see the latest.",
  rate_limited: "That's a lot of requests in a few minutes. Wait a little, then try again.",
};

export function messageFor(code: DomainErrorCode): string {
  return MESSAGES[code];
}

/**
 * Runs a service call for a server action and maps the outcome to a `FormState`.
 * Expected failures become their calm message; anything else is logged and shown as
 * a generic retry message, so internals never reach the browser.
 */
export async function runAction(event: string, work: () => Promise<{ message: string; id: string }>): Promise<FormState> {
  try {
    const { message, id } = await work();
    return { status: "success", message, id };
  } catch (err) {
    if (isDomainError(err)) return { status: "error", message: messageFor(err.code) };
    log.error({ err }, `${event}_failed`);
    return { status: "error", message: "Something went wrong. Try again in a moment." };
  }
}
