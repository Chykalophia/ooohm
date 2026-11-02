import "server-only";
import nodemailer from "nodemailer";
import { env } from "@/lib/env";
import { smtpTransportOptions } from "@/lib/smtp-options";

const transport = nodemailer.createTransport(
  smtpTransportOptions({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    requireTls: env.SMTP_REQUIRE_TLS,
    user: env.SMTP_USER,
    password: env.SMTP_PASSWORD,
  }),
);

/** Sends one email through the configured SMTP server. Throws on transport failure. */
export async function sendMail(opts: { to: string; subject: string; text: string; html?: string }) {
  await transport.sendMail({ from: env.MAIL_FROM, ...opts });
}
