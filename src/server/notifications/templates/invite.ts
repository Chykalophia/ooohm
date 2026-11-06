import type { EmailCopy } from "@/domain/email-template";
import { displayName } from "@/domain/person";
import { buttons, DEFAULT_EMAIL_ACCENT, type EmailAccent, emailDocument, escapeHtml, heading, link, paragraph } from "@/lib/email-layout";
import type { EmailContent } from "./content";
import { type CopyTemplate, type CopyVariable, fillMessage, fillSubject, resolveCopy } from "./copy";

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

/** The invite's default words, and the variables an admin's copy may use. */
export const INVITE_COPY: { defaults: CopyTemplate; variables: readonly CopyVariable[] } = {
  defaults: {
    subject: INVITE_SUBJECT,
    message: "{{inviter}} added you to {{company}} on OOOhm, where you ask for time off and see who's out.",
  },
  variables: [
    { name: "recipient", description: "The invited person's name" },
    { name: "inviter", description: "The name of the admin who invited them" },
    { name: "company", description: "Your company's name" },
  ],
};

/**
 * The invite: a greeting, the message (by default, who invited the person to which
 * company), and their one-time sign-in link. `saved` is the company's own words, if any.
 * The greeting, the button and the expiry line are fixed.
 */
export function renderInviteEmail(input: InviteEmail, accent: EmailAccent = DEFAULT_EMAIL_ACCENT, saved?: EmailCopy | null): EmailContent {
  const recipient = displayName(input.recipientName);
  const values = {
    recipient,
    inviter: displayName(input.inviterName) || "An admin",
    company: displayName(input.companyName) || "your company",
  };
  const copy = resolveCopy(INVITE_COPY.defaults, saved);
  const subject = fillSubject(copy.subject, values, INVITE_COPY.defaults.subject);
  const message = fillMessage(copy.message, values);
  const greeting = recipient ? `Hi ${recipient},` : "Hi,";
  const expiry = "This link works once and expires in 15 minutes. After that, get a new one here with this email address:";

  const text = [greeting, "", ...message.text.flatMap((p) => [p, ""]), `Sign in: ${input.link}`, "", expiry, input.signInUrl, ""].join("\n");
  const [lead, ...more] = message.html;
  const body =
    paragraph(escapeHtml(greeting)) +
    heading(lead) +
    more.map((html) => paragraph(html)).join("") +
    buttons([{ label: "Sign in to OOOhm", href: input.link, variant: "primary" }], accent);
  const footer = `${escapeHtml(expiry)} ${link(input.signInUrl, input.signInUrl, accent)}`;
  return { subject, text, html: emailDocument(body, accent, footer, subject) };
}
