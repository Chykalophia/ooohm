/** The SMTP settings from the environment that decide how the connection is secured. */
export interface SmtpSettings {
  host: string;
  port: number;
  /** TLS from the first byte (port 465). */
  secure: boolean;
  /** On a plain connection (port 587), refuse to continue unless STARTTLS succeeds. */
  requireTls: boolean;
  user?: string;
  password?: string;
}

/**
 * Nodemailer transport options for {@link SmtpSettings}.
 *
 * Without `requireTLS`, nodemailer upgrades a plain connection only when the server
 * offers STARTTLS, so anyone on the path who strips that offer gets the SMTP password
 * and every message (sign-in links included) in clear text. With `requireTls` the send
 * fails instead. Implicit TLS (`secure`) needs no upgrade, so the flag is off there.
 */
export function smtpTransportOptions(settings: SmtpSettings) {
  return {
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    requireTLS: !settings.secure && settings.requireTls,
    auth: settings.user ? { user: settings.user, pass: settings.password } : undefined,
  };
}
