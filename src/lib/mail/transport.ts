/**
 * The seam between OOOhm and whatever delivers its email. Services never see this: they
 * call `ctx.mailer` (`Mailer`, in `src/server/context.ts`), and the composition root wires
 * that to {@link MailTransport.send} of the transport `MAIL_TRANSPORT` picks
 * (`src/lib/mail/index.ts`).
 *
 * To add a provider: implement {@link MailTransport} in its own file here (no SDK needed:
 * most providers take one HTTPS request), add it to `MAIL_TRANSPORTS` in `index.ts`, and
 * add its settings to `src/lib/env.ts`, `.env.example` and `docker-compose.yml`.
 */

/** One email, ready to send: always plain text, usually HTML too. */
export interface OutgoingMail {
  /** `Name <address>` or a bare address (`MAIL_FROM`). */
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Something that delivers email. `send` resolves once the provider has accepted the message, and throws otherwise. */
export interface MailTransport {
  /** Short and stable, for logs: `smtp`, `sendgrid`. */
  readonly name: string;
  send(mail: OutgoingMail): Promise<void>;
}

/**
 * A provider refused or could not take a message. The message names the provider and
 * its answer (HTTP status and the start of its error), never a credential.
 */
export class MailSendError extends Error {
  constructor(
    readonly transport: string,
    message: string,
    readonly status?: number,
  ) {
    super(`${transport}: ${message}`);
    this.name = "MailSendError";
  }
}

/** A mailbox split into address and display name: `OOOhm <no-reply@ooohm.team>` or `no-reply@ooohm.team`. */
export function parseMailbox(value: string): { email: string; name?: string } {
  const match = /^\s*(.*?)\s*<\s*([^<>\s]+)\s*>\s*$/.exec(value);
  if (!match) return { email: value.trim() };
  const name = match[1].replace(/^"(.*)"$/, "$1").trim();
  return name ? { email: match[2], name } : { email: match[2] };
}
