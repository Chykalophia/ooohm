import type { SendGridRegion } from "./names";
import { MailSendError, type MailTransport, type OutgoingMail, parseMailbox } from "./transport";

/** SendGrid's Mail Send endpoint, by data residency. EU accounts send through the EU host. */
export const SENDGRID_ENDPOINTS: Record<SendGridRegion, string> = {
  global: "https://api.sendgrid.com/v3/mail/send",
  eu: "https://api.eu.sendgrid.com/v3/mail/send",
};

/** How long one send may take before it counts as failed. */
const TIMEOUT_MS = 10_000;

export interface SendGridSettings {
  /** An API key with the "Mail Send" permission only. */
  apiKey: string;
  region?: SendGridRegion;
  /** Injected in tests; the global `fetch` otherwise. */
  fetch?: typeof fetch;
}

/**
 * The JSON body of one message. Click and open tracking are off for every message:
 * SendGrid would otherwise rewrite links through its tracking redirect, which breaks
 * (and leaks) sign-in links and Approve links, whose tokens live in the URL.
 */
export function sendGridBody(mail: OutgoingMail) {
  const content = [{ type: "text/plain", value: mail.text }];
  if (mail.html) content.push({ type: "text/html", value: mail.html });
  return {
    personalizations: [{ to: [{ email: mail.to }] }],
    from: parseMailbox(mail.from),
    subject: mail.subject,
    content,
    tracking_settings: {
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
      subscription_tracking: { enable: false },
    },
  };
}

/**
 * SendGrid over its HTTPS API (port 443, so it works where SMTP ports are blocked). A
 * message is sent once SendGrid answers 2xx (202 Accepted); anything else throws
 * {@link MailSendError} with the status and the start of SendGrid's error.
 */
export function createSendGridTransport(settings: SendGridSettings): MailTransport {
  const endpoint = SENDGRID_ENDPOINTS[settings.region ?? "global"];
  const doFetch = settings.fetch ?? fetch;
  return {
    name: "sendgrid",
    async send(mail) {
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(sendGridBody(mail)),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw new MailSendError("sendgrid", `request failed (${err instanceof Error ? err.name : "error"})`);
      }
      if (res.ok) return;
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new MailSendError("sendgrid", `HTTP ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
    },
  };
}
