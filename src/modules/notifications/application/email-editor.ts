import "server-only";
/**
 * The email editor (Admin → Emails): each email's subject and message, in the company's
 * own words. Everything else about an email (the request's details, the buttons and
 * links, the layout) stays as OOOhm sends it, so no edit can break an approve link or
 * leave out who asked for what. These are the rules its queries and use cases share.
 */
import type { Transaction } from "@/db/types";
import type { Actor } from "@/shared/kernel/actor";
import { type EmailCopy, normalizeEmailCopy } from "@/shared/kernel/email-template";
import type { AdminEventType, EmailTemplateEventPayload, Unattributed } from "@/shared/kernel/events";
import { DomainError } from "@/shared/kernel/errors";
import { recordAdminChange } from "@/shared/lib/admin-access";
import { isNotificationKind, NOTIFICATION_TYPES, type NotificationKind } from "./catalog";
import { variableNames } from "./copy";

/** The email types, in the order the editor lists them. */
export const KINDS = Object.keys(NOTIFICATION_TYPES) as NotificationKind[];

/** @throws DomainError `not_found` for a type the catalog does not have. */
export function kindOf(type: string): NotificationKind {
  if (!isNotificationKind(type)) throw new DomainError("not_found");
  return type;
}

/**
 * The email's copy rules for `kind`.
 *
 * @throws DomainError `invalid_input` (with the field) for copy that is too long or uses
 *   a variable the email does not have.
 */
export function normalizeFor(kind: NotificationKind, input: { subject: string; message: string }): EmailCopy {
  const names = variableNames(kind);
  const copy = normalizeEmailCopy(input, { subject: names, message: names });
  // The default, typed out again, is the default: store nothing for it.
  const { defaults } = NOTIFICATION_TYPES[kind].copy;
  return {
    subject: copy.subject === defaults.subject ? null : copy.subject,
    message: copy.message === defaults.message ? null : copy.message,
  };
}

export function labelOf(kind: NotificationKind) {
  const { label, description } = NOTIFICATION_TYPES[kind].copy;
  return { label, description };
}

function payload(kind: NotificationKind, copy: EmailCopy | null): Unattributed<EmailTemplateEventPayload> {
  return { notificationType: kind, subject: copy?.subject ?? null, message: copy?.message ?? null };
}

/** Records one change to an email's copy: the audit row and the outbox event. */
export async function recordCopyChange(
  tx: Transaction,
  actor: Actor,
  type: AdminEventType,
  kind: NotificationKind,
  before: EmailCopy | null,
  after: EmailCopy | null,
) {
  await recordAdminChange(tx, actor, { type, entityType: "email_template", entityId: kind, before, after, payload: payload(kind, after) });
}
