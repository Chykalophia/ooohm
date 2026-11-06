import type { EmailCopy } from "@/domain/email-template";
import type { EmailAccent } from "@/lib/email-layout";
import { NOTIFICATION_TYPES, type NotificationKind } from "./catalog";
import type { EmailContent, NotificationType } from "./types";

/**
 * The email `kind` as it would go out with `copy`, filled with the type's sample data.
 * Sends nothing and issues nothing: a sign-in link is a placeholder to `signInUrl`.
 */
export async function previewNotification(
  kind: NotificationKind,
  copy: EmailCopy | null,
  accent: EmailAccent,
  signInUrl: string,
): Promise<EmailContent> {
  const type = NOTIFICATION_TYPES[kind] as NotificationType<unknown>;
  return type.build(type.copy.sample, { to: "preview@example.com", accent, copy, issueSignInLink: async () => signInUrl });
}
