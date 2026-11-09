import { displayName } from "@/domain/person";
import { buttons, DEFAULT_EMAIL_ACCENT, type EmailAccent, emailDocument, escapeHtml, heading, link, paragraph } from "@/lib/email-layout";
import type { EmailContent } from "./content";

/**
 * The invite an admin's "Invite" or "Resend invite" sends: who added the person, and a
 * one-time sign-in link. Like the leave emails, the subject is fixed and every typed
 * value (names, the company name) appears only in the body, HTML-escaped there.
 */
export interface InviteEmail {
  recipientName: string;
  inviterName: string;
  companyName: string;
  /** One-time sign-in link (15 minutes). */
  link: string;
  /** Where to ask for a fresh link once it has expired. */
  signInUrl: string;
}

export const INVITE_SUBJECT = "You're invited to OOOhm";

/**
 * The invite: who invited the person to which company, and their one-time sign-in link.
 * The subject is fixed ({@link INVITE_SUBJECT}); names appear in the body only.
 */
export function renderInviteEmail(input: InviteEmail, accent: EmailAccent = DEFAULT_EMAIL_ACCENT): EmailContent {
  const recipient = displayName(input.recipientName);
  const inviter = displayName(input.inviterName) || "An admin";
  const company = displayName(input.companyName) || "your company";
  const greeting = recipient ? `Hi ${recipient},` : "Hi,";
  const intro = `${inviter} added you to ${company} on OOOhm, where you ask for time off and see who's out.`;
  const expiry = "This link works once and expires in 15 minutes. After that, get a new one here with this email address:";

  const text = [greeting, "", intro, "", `Sign in: ${input.link}`, "", expiry, input.signInUrl, ""].join("\n");
  const body =
    paragraph(escapeHtml(greeting)) +
    heading(escapeHtml(intro)) +
    buttons([{ label: "Sign in to OOOhm", href: input.link, variant: "primary" }], accent);
  const footer = `${escapeHtml(expiry)} ${link(input.signInUrl, input.signInUrl, accent)}`;
  return { subject: INVITE_SUBJECT, text, html: emailDocument(body, accent, footer, INVITE_SUBJECT) };
}
