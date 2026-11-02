import "server-only";
import nodemailer from "nodemailer";
import { env } from "@/lib/env";

const transport = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE,
  auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
});

/** Sends one email through the configured SMTP server. Throws on transport failure. */
export async function sendMail(opts: { to: string; subject: string; text: string; html?: string }) {
  await transport.sendMail({ from: env.MAIL_FROM, ...opts });
}
