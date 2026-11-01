/** How people are named where others see them: emails, the team view, the team feed. */

/** Longest display name shown; anything beyond is cut. */
const NAME_MAX_LENGTH = 100;

/**
 * A person's name as it may appear to someone else: one line, trimmed and capped, so a
 * name cannot pose as extra paragraphs of a message or extra lines of a calendar.
 */
export function displayName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX_LENGTH).trim();
}

/**
 * How an email names someone other than its recipient: their display name, or their
 * email address when the name is blank. Emails go to the requester and their approver
 * only, who already know the address.
 */
export function personLabel(person: { name: string; email: string }): string {
  return displayName(person.name) || person.email;
}

/**
 * How the team view and team feed name someone: their display name, or the part of
 * their email before the `@` when the name is blank, never the whole address. Every
 * member sees the view, and a feed URL can travel further than the app, so neither
 * should hand out deliverable addresses.
 */
export function teamLabel(person: { name: string; email: string }): string {
  return displayName(person.name) || displayName(person.email.split("@")[0]) || "A teammate";
}
