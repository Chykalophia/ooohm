/**
 * How names and emails are stored: a person's name and email, and the names of
 * departments and levels. Pure; the people and organisation modules, the TimeOff
 * mapping, the inbound sync and the forms (for their length limits) share them.
 */
import { DomainError } from "@/shared/kernel/errors";
import { oneLine } from "@/shared/kernel/text";

/** Longest name an admin may give a person. Display trims further (see `displayName`). */
export const PERSON_NAME_MAX_LENGTH = 100;

/** Longest email address accepted (RFC 5321's limit on a forward path). */
export const EMAIL_MAX_LENGTH = 254;

// Exactly the rule Better Auth's magic-link endpoint applies (zod's `z.email()`,
// copied because the domain takes no dependencies; a unit test keeps the two in step).
// Anything looser would let an invite create an account that can never get a sign-in
// link, and would store address-list syntax (`,`, `<>`) a mailer could misread.
const EMAIL = /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;

/**
 * An email as it is stored: trimmed and lowercased (`user_email_lowercase` requires it,
 * and Better Auth looks addresses up lowercased).
 *
 * @throws DomainError `invalid_input` when it is not an email address.
 */
export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL.test(email)) {
    throw new DomainError("invalid_input", "That isn't an email address.", { field: "email" });
  }
  return email;
}

/**
 * A person's name as stored: whitespace collapsed to single spaces and trimmed, so a
 * name is always one line.
 *
 * @throws DomainError `invalid_input` when blank or longer than {@link PERSON_NAME_MAX_LENGTH}.
 */
export function normalizePersonName(raw: string): string {
  const name = oneLine(raw);
  if (name.length === 0 || name.length > PERSON_NAME_MAX_LENGTH) {
    throw new DomainError("invalid_input", `Names are 1 to ${PERSON_NAME_MAX_LENGTH} characters.`, { field: "name" });
  }
  return name;
}

export const LEVEL_NAME_MAX_LENGTH = 60;

/**
 * A level name as stored: one line, trimmed.
 *
 * @throws DomainError `invalid_input` when blank or longer than {@link LEVEL_NAME_MAX_LENGTH}.
 */
export function normalizeLevelName(raw: string): string {
  const name = oneLine(raw);
  if (name.length === 0 || name.length > LEVEL_NAME_MAX_LENGTH) {
    throw new DomainError("invalid_input", `Level names are 1 to ${LEVEL_NAME_MAX_LENGTH} characters.`, { field: "name" });
  }
  return name;
}

export const DEPARTMENT_NAME_MAX_LENGTH = 60;

/**
 * A department name as stored: one line, trimmed.
 *
 * @throws DomainError `invalid_input` when blank or longer than {@link DEPARTMENT_NAME_MAX_LENGTH}.
 */
export function normalizeDepartmentName(raw: string): string {
  const name = oneLine(raw);
  if (name.length === 0 || name.length > DEPARTMENT_NAME_MAX_LENGTH) {
    throw new DomainError("invalid_input", `Department names are 1 to ${DEPARTMENT_NAME_MAX_LENGTH} characters.`, { field: "name" });
  }
  return name;
}
