import type { MailTransportName, SendGridRegion } from "./names";
import { createSendGridTransport } from "./sendgrid";
import { createSmtpTransport } from "./smtp";
import type { SmtpSettings } from "./smtp-options";
import type { MailTransport } from "./transport";

/** Everything any transport might need; each reads only its own part. */
export interface MailConfig {
  transport: MailTransportName;
  smtp: SmtpSettings;
  sendgrid: { apiKey?: string; region: SendGridRegion };
}

/**
 * How each transport is built from {@link MailConfig}. A new provider is one entry here
 * (and its name in `MAIL_TRANSPORT_NAMES`, in `names.ts`).
 */
const MAIL_TRANSPORTS: Record<MailTransportName, (config: MailConfig) => MailTransport> = {
  smtp: (config) => createSmtpTransport(config.smtp),
  sendgrid: (config) => {
    if (!config.sendgrid.apiKey) throw new Error("MAIL_TRANSPORT=sendgrid needs SENDGRID_API_KEY.");
    return createSendGridTransport({ apiKey: config.sendgrid.apiKey, region: config.sendgrid.region });
  },
};

/** The transport `config.transport` names, built. Throws when its required settings are missing. */
export function createMailTransport(config: MailConfig): MailTransport {
  return MAIL_TRANSPORTS[config.transport](config);
}
