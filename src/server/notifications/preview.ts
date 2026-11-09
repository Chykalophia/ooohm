import type { EmailCopy } from "@/domain/email-template";
import type { EmailAccent } from "@/lib/email-layout";
import { NOTIFICATION_TYPES, type NotificationKind, PREVIEW_SIGN_IN_URL } from "./catalog";
import type { EmailContent, NotificationType } from "./types";

/**
 * The email `kind` as it would go out with `copy`, filled with the type's sample data.
 * Sends nothing and issues nothing: every link, a sign-in link included, is a placeholder
 * like the sample's own ({@link PREVIEW_SIGN_IN_URL}).
 */
export async function previewNotification(kind: NotificationKind, copy: EmailCopy | null, accent: EmailAccent): Promise<EmailContent> {
  const type = NOTIFICATION_TYPES[kind] as NotificationType<unknown>;
  return type.build(type.copy.sample, { to: "preview@example.com", accent, copy, issueSignInLink: async () => PREVIEW_SIGN_IN_URL });
}
