import nodemailer from "nodemailer";
import { type SmtpSettings, smtpTransportOptions } from "./smtp-options";
import type { MailTransport } from "./transport";

/**
 * Any SMTP server (Mailpit in development; a provider's submission port 587 or 465 in
 * production). How the connection is secured is decided in {@link smtpTransportOptions}.
 */
export function createSmtpTransport(settings: SmtpSettings): MailTransport {
  const transport = nodemailer.createTransport(smtpTransportOptions(settings));
  return {
    name: "smtp",
    async send(mail) {
      await transport.sendMail(mail);
    },
  };
}
