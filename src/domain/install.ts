/**
 * The first install: what a brand-new OOOhm starts with, and the checks on what the
 * person setting it up types in. Shared by the web setup (`/setup`) and `pnpm db:seed`.
 */
import { COMPANY_NAME_MAX_LENGTH, isSupportedTimeZone } from "./company-settings";
import { DomainError } from "./errors";
import { normalizeEmail, normalizePersonName } from "./people";
import { oneLine } from "./text";

/**
 * The leave types a new company starts with, PTO first: the first active type is the
 * request form's default and the one Home's year-end note names. Allowances are
 * starting points an admin can change.
 */
export const DEFAULT_LEAVE_TYPES = [
  { code: "PTO", name: "PTO (Scheduled Time Off)", color: "#0f766e", defaultAllowanceDays: 15 },
  { code: "EMERGENCY", name: "Emergency Leave", color: "#b45309", defaultAllowanceDays: 3 },
  { code: "SICK", name: "Sick Leave", color: "#be123c", defaultAllowanceDays: 5 },
  { code: "BONUS", name: "Bonus Time Off", color: "#7c3aed", defaultAllowanceDays: 0 },
] as const;

/** The default leave types with every setting spelled out (paid, counted, carryover off). */
export function defaultLeaveTypes() {
  return DEFAULT_LEAVE_TYPES.map((t, sortOrder) => ({
    ...t,
    isPaid: true,
    countsAgainstAllowance: true,
    carryoverEnabled: false,
    carryoverMaxDays: null,
    sortOrder,
  }));
}

/** What the setup page asks for. */
export interface InstallInput {
  companyName: string;
  timezone: string;
  adminName: string;
  adminEmail: string;
}

/**
 * Checks and normalizes the setup form.
 *
 * @throws DomainError `invalid_input`: a blank or long company or person name, a time
 *   zone not in the list, or an email that isn't one.
 */
export function normalizeInstall(input: InstallInput): InstallInput {
  const companyName = oneLine(input.companyName);
  if (companyName.length === 0 || companyName.length > COMPANY_NAME_MAX_LENGTH) {
    throw new DomainError("invalid_input", `Company names are 1 to ${COMPANY_NAME_MAX_LENGTH} characters.`);
  }
  const timezone = input.timezone.trim();
  if (!isSupportedTimeZone(timezone)) throw new DomainError("invalid_input", "Unknown time zone.");
  return { companyName, timezone, adminName: normalizePersonName(input.adminName), adminEmail: normalizeEmail(input.adminEmail) };
}
