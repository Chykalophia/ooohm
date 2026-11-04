import { buttons, DEFAULT_EMAIL_ACCENT, type EmailAccent, emailDocument, escapeHtml, heading } from "./email-layout";

/** How long a sign-in link works; Better Auth's `expiresIn` uses it too. */
export const SIGN_IN_LINK_MINUTES = 15;

export const SIGN_IN_SUBJECT = "Your OOOhm sign-in link";

/** The sign-in link someone asked for on the sign-in page. Nothing typed by anyone appears in it. */
export function renderSignInEmail(url: string, accent: EmailAccent = DEFAULT_EMAIL_ACCENT): { subject: string; text: string; html: string } {
  const note = `This link expires in ${SIGN_IN_LINK_MINUTES} minutes. If you didn't ask for it, you can ignore this email.`;
  const text = `Sign in to OOOhm:\n\n${url}\n\n${note}`;
  const body =
    heading("Here's your link to sign in to OOOhm.") + buttons([{ label: "Sign in", href: url, variant: "primary" }], accent);
  return { subject: SIGN_IN_SUBJECT, text, html: emailDocument(body, accent, escapeHtml(note), SIGN_IN_SUBJECT) };
}
