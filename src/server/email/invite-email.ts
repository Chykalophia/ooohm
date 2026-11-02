import { displayName } from "@/domain/person";
import { type EmailContent, escapeHtml } from "./leave-emails";

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

export function renderInviteEmail(input: InviteEmail): EmailContent {
  const recipient = displayName(input.recipientName);
  const inviter = displayName(input.inviterName) || "An admin";
  const company = displayName(input.companyName) || "your company";
  const greeting = recipient ? `Hi ${recipient},` : "Hi,";
  const intro = `${inviter} added you to ${company} on OOOhm, where you ask for time off and see who's out.`;
  const expiry = "This link works once and expires in 15 minutes. After that, get a new one here with this email address:";

  const text = [greeting, "", intro, "", `Sign in: ${input.link}`, "", expiry, input.signInUrl, ""].join("\n");
  const html =
    `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#1c1917;line-height:1.5;max-width:480px">` +
    `<p>${escapeHtml(greeting)}</p>` +
    `<p>${escapeHtml(intro)}</p>` +
    `<p><a href="${escapeHtml(input.link)}" style="color:#0f766e">Sign in to OOOhm</a></p>` +
    `<p style="color:#78716c">${escapeHtml(expiry)} <a href="${escapeHtml(input.signInUrl)}" style="color:#0f766e">${escapeHtml(input.signInUrl)}</a></p>` +
    `</div>`;
  return { subject: INVITE_SUBJECT, text, html };
}
