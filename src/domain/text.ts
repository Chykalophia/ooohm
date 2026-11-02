/**
 * Text on one line: every run of whitespace (newlines and tabs included) becomes one
 * space, and the ends are trimmed. Names and labels go through it before they are
 * checked and stored, so one cannot pose as several lines of an email or a calendar.
 */
export function oneLine(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}
