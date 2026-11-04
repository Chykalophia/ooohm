/**
 * Validation for what admins type about leave: leave type settings and per-person
 * allowance overrides. Every day amount is stored as `numeric(5,1)`, so amounts are
 * whole tenths of a day.
 */
import { addDays } from "./allowance-policy";
import { DomainError } from "./errors";
import { NOTE_MAX_LENGTH } from "./leave-request";
import { oneLine } from "./text";

export const LEAVE_TYPE_NAME_MAX_LENGTH = 60;
export const LEAVE_TYPE_CODE_MAX_LENGTH = 12;
/** Largest allowance, default or carryover cap: a year of days. */
export const MAX_ALLOWANCE_DAYS = 366;
/**
 * A neutral grey: the column default for a leave type's colour, and what calendars
 * show for a stored colour that is not a hex value.
 */
export const DEFAULT_LEAVE_TYPE_COLOR = "#6b7280";

/** Uppercase letters and digits first, then also `_` or `-`; at most 12 characters. */
const CODE = new RegExp(`^[A-Z0-9][A-Z0-9_-]{0,${LEAVE_TYPE_CODE_MAX_LENGTH - 1}}$`);
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * A leave type's short code as stored, e.g. `PTO`: trimmed and uppercased. It labels
 * calendar chips and feed events, so it stays short and plain.
 *
 * @throws DomainError `invalid_input`.
 */
export function normalizeLeaveTypeCode(raw: string): string {
  const code = raw.trim().toUpperCase();
  if (!CODE.test(code)) {
    throw new DomainError("invalid_input", `Codes are 1 to ${LEAVE_TYPE_CODE_MAX_LENGTH} letters, digits, - or _.`, { field: "code" });
  }
  return code;
}

/**
 * A leave type colour as stored: `#rrggbb`, lowercase (`#abc` is expanded). Labels on
 * a solid chip of any such colour stay legible because calendars pick black or white
 * text by contrast (`readableTextColor`), so any hex colour is allowed.
 *
 * @throws DomainError `invalid_input` for anything that is not a hex colour.
 */
export function normalizeLeaveTypeColor(raw: string): string {
  const m = HEX.exec(raw.trim());
  if (!m) throw new DomainError("invalid_input", "Colours are hex values like #0f766e.", { field: "color" });
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${hex.toLowerCase()}`;
}

/**
 * A day amount as stored: finite, in whole tenths, within `[min, max]`.
 *
 * @throws DomainError `invalid_input`.
 */
export function normalizeDayAmount(value: number, range: { min: number; max: number }): number {
  if (!Number.isFinite(value) || value < range.min || value > range.max) {
    throw new DomainError("invalid_input", `Day amounts are between ${range.min} and ${range.max}.`);
  }
  const tenths = value * 10;
  if (Math.abs(tenths - Math.round(tenths)) > 1e-9) {
    throw new DomainError("invalid_input", "Day amounts use at most one decimal place, like 2.5.");
  }
  return addDays(value);
}

function normalizeName(raw: string, max: number): string {
  const name = oneLine(raw);
  if (name.length === 0 || name.length > max) throw new DomainError("invalid_input", `Names are 1 to ${max} characters.`);
  return name;
}

/** Everything an admin sets on a leave type. */
export interface LeaveTypeSettings {
  name: string;
  code: string;
  color: string;
  isPaid: boolean;
  countsAgainstAllowance: boolean;
  /** Yearly allowance for anyone without their own row; `null` = no default. */
  defaultAllowanceDays: number | null;
  carryoverEnabled: boolean;
  /** Most days carried into the next year; `null` = no cap. */
  carryoverMaxDays: number | null;
}

/**
 * Checks and normalizes leave type settings.
 *
 * @throws DomainError `invalid_input` for a blank or long name, a bad code or colour,
 *   or a default or carryover cap that is negative, over {@link MAX_ALLOWANCE_DAYS}, or
 *   finer than a tenth of a day.
 */
export function normalizeLeaveTypeSettings(input: LeaveTypeSettings): LeaveTypeSettings {
  const days = (v: number | null) => (v === null ? null : normalizeDayAmount(v, { min: 0, max: MAX_ALLOWANCE_DAYS }));
  return {
    name: normalizeName(input.name, LEAVE_TYPE_NAME_MAX_LENGTH),
    code: normalizeLeaveTypeCode(input.code),
    color: normalizeLeaveTypeColor(input.color),
    isPaid: input.isPaid,
    countsAgainstAllowance: input.countsAgainstAllowance,
    defaultAllowanceDays: days(input.defaultAllowanceDays),
    carryoverEnabled: input.carryoverEnabled,
    carryoverMaxDays: days(input.carryoverMaxDays),
  };
}

/** Allowance years an admin may view. Editing is narrower: see {@link firstEditableAllowanceYear}. */
export const ALLOWANCE_YEAR_MIN = 2000;
export const ALLOWANCE_YEAR_MAX = 2100;

/**
 * The earliest year whose allowance an admin may still edit: last year. The carry out
 * of a year lives in the next year's `carried_over_days`, which only the year rollover
 * computes, and the nightly rollover closes only last year. So an edit to last year
 * can be re-carried at once (the edit does that), but an edit to any earlier year
 * would leave every later year's carry stale for good. Older years are history.
 */
export function firstEditableAllowanceYear(currentYear: number): number {
  return currentYear - 1;
}

/** An admin's override of one person's allowance for one leave type and year. */
export interface AllowanceEdit {
  /** The year's base allowance, replacing the leave type default for this person. */
  days: number;
  /** A correction on top, positive or negative. */
  adjustmentDays: number;
  /** Why; required, because every balance change must be explainable later. */
  reason: string;
}

/**
 * Checks an allowance override. `days` may be lowered below what is already booked:
 * the balance then shows a negative remaining rather than the edit being refused.
 *
 * @throws DomainError `invalid_input` for an amount out of range or finer than a
 *   tenth, or a blank or long reason.
 */
export function normalizeAllowanceEdit(input: AllowanceEdit): AllowanceEdit {
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > NOTE_MAX_LENGTH) {
    throw new DomainError("invalid_input", `A reason of 1 to ${NOTE_MAX_LENGTH} characters is required.`);
  }
  return {
    days: normalizeDayAmount(input.days, { min: 0, max: MAX_ALLOWANCE_DAYS }),
    adjustmentDays: normalizeDayAmount(input.adjustmentDays, { min: -MAX_ALLOWANCE_DAYS, max: MAX_ALLOWANCE_DAYS }),
    reason,
  };
}

/**
 * @param currentYear The current year in the company's time zone.
 * @throws DomainError `invalid_input` for a year before {@link firstEditableAllowanceYear}
 *   or after {@link ALLOWANCE_YEAR_MAX}.
 */
export function assertAllowanceYear(year: number, currentYear: number): void {
  if (!Number.isInteger(year) || year < Math.max(ALLOWANCE_YEAR_MIN, firstEditableAllowanceYear(currentYear)) || year > ALLOWANCE_YEAR_MAX) {
    throw new DomainError("invalid_input", "That year can't be edited.");
  }
}
