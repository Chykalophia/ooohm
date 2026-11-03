import "server-only";
import { env } from "@/lib/env";
import { createMailTransport } from "./registry";
import type { MailTransport } from "./transport";

let transport: MailTransport | undefined;

/**
 * The transport `MAIL_TRANSPORT` picks, built on first use: a build or a page that sends
 * nothing never needs the mail settings.
 */
export function mailTransport(): MailTransport {
  transport ??= createMailTransport({
    transport: env.MAIL_TRANSPORT,
    smtp: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      requireTls: env.SMTP_REQUIRE_TLS,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
    },
    sendgrid: { apiKey: env.SENDGRID_API_KEY, region: env.SENDGRID_REGION },
  });
  return transport;
}

/** Sends one email from `MAIL_FROM` through the configured transport. Throws when it is not accepted. */
export async function sendMail(opts: { to: string; subject: string; text: string; html?: string }) {
  await mailTransport().send({ from: env.MAIL_FROM, ...opts });
}
