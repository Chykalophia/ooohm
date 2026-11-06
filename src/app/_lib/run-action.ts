import "server-only";
import { type DomainError, type DomainErrorCode, isDomainError } from "@/domain/errors";
import { formatNoWorkingDays, formatShortfall } from "@/lib/format";
import { log } from "@/lib/log";

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
  past_year_closed: "That time off is from a past year, which is closed, so it can't be cancelled. An admin can adjust that year's balance instead.",
  leave_taken: "That time off is over, so it can't be cancelled. If it's wrong, ask your manager or an admin to correct it.",
  conflict: "Someone else just updated that request. Refresh to see the latest.",
  rate_limited: "That's a lot of requests in a few minutes. Wait a little, then try again.",
  insufficient_balance: "There aren't enough days left for that.",
  policy_unavailable: "Balances aren't set up correctly yet. Ask an admin to check the company's allowance policy.",
  last_admin: "There has to be at least one active admin. Make someone else an admin first.",
  already_exists: "That already exists.",
  invalid_manager: "Pick a manager who is an active member of the company, other than this person.",
  manager_cycle: "That manager reports to this person, directly or through others. Pick someone else.",
  department_not_empty: "That department still has people in it. Move them to another department first.",
  self_change_not_allowed: "You can't deactivate your own account. Ask another admin.",
  insecure_url: "Use an address that starts with https://.",
  blocked_address: "That address points inside a private network. Use a public address.",
  limit_reached: "You've reached the limit. Remove one you no longer use first.",
  import_refused: "That import can't run. The import tool says why.",
  deletion_blocked: "This person can't be deleted yet. Deactivate them, and give the people they manage another manager, first.",
  confirmation_mismatch: "Type their full name exactly as shown to confirm.",
};

/**
 * Codes that mean the deployment is misconfigured rather than that the person made a
 * mistake. They still get a calm message, and an operator gets an error log line.
 */
const MISCONFIGURATION: ReadonlySet<DomainErrorCode> = new Set(["policy_unavailable"]);

export function messageFor(code: DomainErrorCode): string {
  return MESSAGES[code];
}

/**
 * The calm message for an expected failure, worded from its details when it has
 * them (e.g. how many days are left), and logged when it signals misconfiguration.
 *
 * @param event Log event prefix, e.g. `leave_request_submit`.
 */
export function messageForError(err: DomainError, event: string): string {
  if (MISCONFIGURATION.has(err.code)) log.error({ err }, `${event}_misconfigured`);
  if (err.code === "insufficient_balance" && err.details && "year" in err.details) return formatShortfall(err.details);
  if (err.code === "zero_days" && err.details && "holidays" in err.details) return formatNoWorkingDays(err.details.holidays);
  return messageFor(err.code);
}

/**
 * What a failed server action returns: a calm message, never internals. `fields` names
 * the submitted fields the action refused, by its schema or by a domain check (an
 * `invalid_input` error's `field`), so the form can mark them invalid.
 */
export type ActionError = { status: "error"; message: string; fields?: string[] };

const GENERIC_FAILURE = "Something went wrong. Try again in a moment.";

/**
 * Runs a service call for a server action. Expected failures become their calm
 * message; anything else is logged as `<event>_failed` and shown as a generic retry
 * message, so internals never reach the browser.
 *
 * @param messages Wording for codes whose default message would not fit this action
 *   (e.g. `forbidden` talks about requests).
 */
export async function runActionWith<S>(
  event: string,
  work: () => Promise<S>,
  messages: Partial<Record<DomainErrorCode, string>> = {},
): Promise<S | ActionError> {
  try {
    return await work();
  } catch (err) {
    if (isDomainError(err)) {
      const message = messages[err.code] ?? messageForError(err, event);
      const field = err.code === "invalid_input" && err.details && "field" in err.details ? err.details.field : undefined;
      return { status: "error", message, ...(field ? { fields: [field] } : {}) };
    }
    log.error({ err }, `${event}_failed`);
    return { status: "error", message: GENERIC_FAILURE };
  }
}
