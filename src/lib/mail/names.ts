/** The transports `MAIL_TRANSPORT` can name (built in `registry.ts`). Kept apart so env validation loads no mailer. */
export const MAIL_TRANSPORT_NAMES = ["smtp", "sendgrid"] as const;
export type MailTransportName = (typeof MAIL_TRANSPORT_NAMES)[number];

/** SendGrid's data residency regions (`SENDGRID_REGION`). */
export const SENDGRID_REGIONS = ["global", "eu"] as const;
export type SendGridRegion = (typeof SENDGRID_REGIONS)[number];
