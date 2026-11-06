/**
 * Validation for a company's settings: name, time zone, working days and allowance
 * policy. Changing working days or the time zone affects future day counting only:
 * submitted requests keep the per-year split stored with them (`leave_request_days`).
 */
import { ALLOWANCE_POLICY_KEYS } from "./allowance-policy";
import { type ApprovalMode, isApprovalMode } from "./approval-rule";
import { DomainError } from "./errors";
import { oneLine } from "./text";

export const COMPANY_NAME_MAX_LENGTH = 100;

/** ISO weekdays, Monday first: 1 = Monday ... 7 = Sunday. */
export const ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

let zones: ReadonlySet<string> | undefined;

/**
 * Time zones a company may choose: the runtime's IANA list
 * (`Intl.supportedValuesOf("timeZone")`), plus `UTC`, which that list leaves out
 * although every runtime accepts it. ICU lists canonical names, so a few aliases
 * (e.g. `Asia/Kolkata`, listed as `Asia/Calcutta`) are not offered.
 */
export function supportedTimeZones(): ReadonlySet<string> {
  zones ??= new Set(["UTC", ...Intl.supportedValuesOf("timeZone")]);
  return zones;
}

export function isSupportedTimeZone(value: string): boolean {
  return supportedTimeZones().has(value);
}

export interface CompanySettingsInput {
  name: string;
  timezone: string;
  workingDays: readonly number[];
  allowancePolicy: string;
  /** Wait `DELETION_GRACE_DAYS` before a full scrub, with undo. Left as it is when absent. */
  deletionGrace?: boolean;
  /** Managers see their direct reports' balances and notes. Left as it is when absent. */
  managersSeeDetails?: boolean;
  /** `required` or `heads_up` ({@link ApprovalMode}). Left as it is when absent. */
  approvalMode?: string;
}

export interface CompanySettings {
  name: string;
  timezone: string;
  /** Distinct ISO weekdays, ascending. */
  workingDays: number[];
  allowancePolicy: string;
  /** Present only when the input set it. */
  deletionGrace?: boolean;
  /** Present only when the input set it. */
  managersSeeDetails?: boolean;
  /** Present only when the input set it. */
  approvalMode?: ApprovalMode;
}

/**
 * Checks and normalizes company settings.
 *
 * @param currentTimezone The zone stored now. It is accepted unchanged even when not
 *   in {@link supportedTimeZones} (an alias written before this check existed), so
 *   saving other settings never fails on it; choosing a new zone must pass the check.
 * @throws DomainError `invalid_input`: blank or long name, unknown time zone, no
 *   working day or one outside 1 to 7, an allowance policy nobody registered, or an
 *   unknown approval mode.
 */
export function normalizeCompanySettings(input: CompanySettingsInput, currentTimezone?: string): CompanySettings {
  const name = oneLine(input.name);
  if (name.length === 0 || name.length > COMPANY_NAME_MAX_LENGTH) {
    throw new DomainError("invalid_input", `Company names are 1 to ${COMPANY_NAME_MAX_LENGTH} characters.`, { field: "name" });
  }
  const timezone = input.timezone.trim();
  if (timezone !== currentTimezone && !isSupportedTimeZone(timezone)) {
    throw new DomainError("invalid_input", "Unknown time zone.");
  }
  const workingDays = normalizeWorkingDays(input.workingDays);
  if (!ALLOWANCE_POLICY_KEYS.includes(input.allowancePolicy)) {
    throw new DomainError("invalid_input", "Unknown allowance policy.");
  }
  const out: CompanySettings = { name, timezone, workingDays, allowancePolicy: input.allowancePolicy };
  if (input.deletionGrace !== undefined) out.deletionGrace = input.deletionGrace === true;
  if (input.managersSeeDetails !== undefined) out.managersSeeDetails = input.managersSeeDetails === true;
  if (input.approvalMode !== undefined) {
    if (!isApprovalMode(input.approvalMode)) throw new DomainError("invalid_input", "Unknown approval setting.", { field: "approvalMode" });
    out.approvalMode = input.approvalMode;
  }
  return out;
}

/**
 * Distinct ISO weekdays in ascending order.
 *
 * @throws DomainError `invalid_input` when empty or when a day is not an integer 1 to 7.
 */
export function normalizeWorkingDays(days: readonly number[]): number[] {
  if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    throw new DomainError("invalid_input", "Working days are weekdays 1 (Monday) to 7 (Sunday).", { field: "workingDays" });
  }
  const out = [...new Set(days)].sort((a, b) => a - b);
  if (out.length === 0) throw new DomainError("invalid_input", "Pick at least one working day.", { field: "workingDays" });
  return out;
}

/** How the settings form names each registered allowance policy. */
export const ALLOWANCE_POLICY_LABELS: Readonly<Record<string, string>> = {
  annual_calendar_year: "Yearly allowance, resets on January 1",
};

/** How the settings form names each approval mode. */
export const APPROVAL_MODE_LABELS: Readonly<Record<ApprovalMode, { label: string; description: string }>> = {
  required: { label: "Ask first", description: "People ask, and their manager approves before the time off is booked." },
  heads_up: {
    label: "Just let us know",
    description: "Time off is booked as soon as it's sent. Their manager gets an email about it; nobody has to approve it.",
  },
};
