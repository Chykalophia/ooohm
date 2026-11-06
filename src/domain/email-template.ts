import { DomainError } from "./errors";

/**
 * The words of an email an admin can change: its subject and its message, written with
 * `{{variable}}` placeholders the email fills in (`{{requester}}`, `{{dates}}`). Pure, so
 * the editor's checks and the send-time filling are one set of rules.
 *
 * Values are never read as templates, and a template never makes markup: the renderer
 * escapes every piece, so neither an admin nor a typed name can add HTML or a header.
 */

/** Longest subject an admin may save, before variables are filled. */
export const EMAIL_SUBJECT_MAX = 150;
/** Longest message an admin may save. */
export const EMAIL_MESSAGE_MAX = 2000;

/** A `{{name}}` placeholder; only spaces and tabs may pad the name, so one never spans lines. */
const VARIABLE = /\{\{[ \t]*([a-z][a-z_]*)[ \t]*\}\}/g;

/** The variable names a template uses, in order, repeats included. */
export function templateVariables(template: string): string[] {
  return [...template.matchAll(VARIABLE)].map((m) => m[1]);
}

/** The variables `template` uses that are not in `allowed`, each once, in order. */
export function unknownVariables(template: string, allowed: readonly string[]): string[] {
  return [...new Set(templateVariables(template).filter((name) => !allowed.includes(name)))];
}

/** One run of a filled template: typed text, or a variable's value (`variable` names it). */
export interface FilledPart {
  text: string;
  variable?: string;
}

/**
 * `template` with each variable swapped for its value. Values go in as plain text and
 * are never searched for variables. An unknown variable fills as nothing: saved copy is
 * checked first ({@link normalizeEmailCopy}), so that happens only for copy saved before a
 * variable was withdrawn.
 */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): FilledPart[] {
  const parts: FilledPart[] = [];
  let at = 0;
  for (const match of template.matchAll(VARIABLE)) {
    if (match.index > at) parts.push({ text: template.slice(at, match.index) });
    parts.push({ text: Object.hasOwn(values, match[1]) ? values[match[1]] : "", variable: match[1] });
    at = match.index + match[0].length;
  }
  if (at < template.length) parts.push({ text: template.slice(at) });
  return parts;
}

/** An admin's words for one email; `null` means the email's own default. */
export interface EmailCopy {
  subject: string | null;
  message: string | null;
}

/** Which variables each field may use. The subject's are those safe on one line in a header. */
export interface CopyVariables {
  subject: readonly string[];
  message: readonly string[];
}

/** Collapses `value` to one trimmed line. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Trims `value`, uses `\n` line ends, and keeps at most one blank line between paragraphs. */
function paragraphs(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * An admin's copy, ready to store: the subject on one line, the message's paragraphs kept,
 * and a blank field as `null` (the default).
 *
 * @throws DomainError `invalid_input` with the field (`subject` or `message`) that is too
 *   long or uses a variable this email does not have.
 */
export function normalizeEmailCopy(input: { subject: string; message: string }, allowed: CopyVariables): EmailCopy {
  const subject = oneLine(input.subject);
  const message = paragraphs(input.message);
  if (subject.length > EMAIL_SUBJECT_MAX || unknownVariables(subject, allowed.subject).length > 0) {
    throw new DomainError("invalid_input", "subject", { field: "subject" });
  }
  if (message.length > EMAIL_MESSAGE_MAX || unknownVariables(message, allowed.message).length > 0) {
    throw new DomainError("invalid_input", "message", { field: "message" });
  }
  return { subject: subject || null, message: message || null };
}
