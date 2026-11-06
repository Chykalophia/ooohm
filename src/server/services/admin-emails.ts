import type { Actor } from "@/domain/actor";
import { assertCanAdminister } from "@/domain/admin-permissions";
import { type EmailCopy, normalizeEmailCopy } from "@/domain/email-template";
import { ADMIN_EVENT_TYPES, type AdminEventType, type EmailTemplateEventPayload, type Unattributed } from "@/domain/events";
import { DomainError } from "@/domain/errors";
import type { ServiceContext } from "@/server/context";
import { emailAccentFor } from "@/server/notifications/accent";
import { isNotificationKind, NOTIFICATION_TYPES, type NotificationKind } from "@/server/notifications/catalog";
import { usableCopy, variableNames } from "@/server/notifications/copy";
import { previewNotification } from "@/server/notifications/preview";
import type { EmailContent } from "@/server/notifications/types";
import { lockCompany } from "@/server/repositories/companies";
import { deleteEmailTemplate, findEmailTemplate, listEmailTemplates, upsertEmailTemplate } from "@/server/repositories/email-templates";
import { assertActiveAdmin, recordAdminChange } from "./admin-access";
import { inTransaction } from "./notify";

/**
 * The email editor (Admin → Emails): each email's subject and message, in the company's
 * own words. Everything else about an email (the request's details, the buttons and
 * links, the layout) stays as OOOhm sends it, so no edit can break an approve link or
 * leave out who asked for what.
 */

/** One email as Admin → Emails lists it. */
export interface EmailListItem {
  type: NotificationKind;
  label: string;
  description: string;
  /** The company has its own words for it. */
  customized: boolean;
}

/** The email types, in the order the editor lists them. */
const KINDS = Object.keys(NOTIFICATION_TYPES) as NotificationKind[];

function kindOf(type: string): NotificationKind {
  if (!isNotificationKind(type)) throw new DomainError("not_found");
  return type;
}

/**
 * The company's admin checks and the email's copy rules for `type`.
 *
 * @throws DomainError `invalid_input` (with the field) for copy that is too long or uses
 *   a variable the email does not have.
 */
function normalizeFor(kind: NotificationKind, input: { subject: string; message: string }): EmailCopy {
  const names = variableNames(kind);
  const copy = normalizeEmailCopy(input, { subject: names, message: names });
  // The default, typed out again, is the default: store nothing for it.
  const { defaults } = NOTIFICATION_TYPES[kind].copy;
  return {
    subject: copy.subject === defaults.subject ? null : copy.subject,
    message: copy.message === defaults.message ? null : copy.message,
  };
}

/** @throws DomainError `forbidden`. */
export async function listEmailsForAdmin(ctx: ServiceContext, actor: Actor): Promise<EmailListItem[]> {
  assertCanAdminister(actor);
  const saved = new Set((await listEmailTemplates(ctx.db, actor.companyId)).map((r) => r.type));
  return KINDS.map((type) => ({ type, ...labelOf(type), customized: saved.has(type) }));
}

function labelOf(kind: NotificationKind) {
  const { label, description } = NOTIFICATION_TYPES[kind].copy;
  return { label, description };
}

/**
 * One email for the editor: what it is, its variables, its defaults and the company's
 * saved words (`null` when it uses the defaults). A saved field that names a variable the
 * email no longer has is shown as the default, as it is sent, so the editor still opens
 * and saving or resetting replaces it.
 *
 * @throws DomainError `forbidden` or `not_found`.
 */
export async function getEmailForAdmin(ctx: ServiceContext, actor: Actor, type: string) {
  assertCanAdminister(actor);
  const kind = kindOf(type);
  const row = await findEmailTemplate(ctx.db, actor.companyId, kind);
  const { copy } = NOTIFICATION_TYPES[kind];
  return {
    type: kind,
    ...labelOf(kind),
    variables: copy.variables,
    defaults: copy.defaults,
    saved: row ? usableCopy(kind, { subject: row.subject, message: row.message }) : null,
  };
}

/**
 * The email as it would go out with `draft`, filled with made-up data and the company's
 * accent. Saves and sends nothing.
 *
 * @throws DomainError `forbidden`, `not_found` or `invalid_input` (as {@link saveEmailCopy}).
 */
export async function previewEmail(
  ctx: ServiceContext,
  actor: Actor,
  type: string,
  draft: { subject: string; message: string },
): Promise<EmailContent> {
  assertCanAdminister(actor);
  const kind = kindOf(type);
  const copy = normalizeFor(kind, draft);
  return previewNotification(kind, copy, await emailAccentFor(ctx, actor.companyId)());
}

function payload(kind: NotificationKind, copy: EmailCopy | null): Unattributed<EmailTemplateEventPayload> {
  return { notificationType: kind, subject: copy?.subject ?? null, message: copy?.message ?? null };
}

/**
 * Saves the company's words for one email. A blank field, or one typed exactly as the
 * default, uses the default; when both do, the email goes back to its defaults (as
 * {@link resetEmailCopy}). Saving what is already saved records nothing.
 *
 * Records `email_template.updated` (or `.reset`), with the words before and after.
 *
 * @returns The copy now in force (`null` fields are the defaults).
 * @throws DomainError `forbidden`, `not_found`, `no_company`, or `invalid_input` with the
 *   field (`subject` or `message`) that is too long or names a variable the email does not have.
 */
export async function saveEmailCopy(
  ctx: ServiceContext,
  actor: Actor,
  type: string,
  input: { subject: string; message: string },
): Promise<EmailCopy> {
  assertCanAdminister(actor);
  const kind = kindOf(type);
  const copy = normalizeFor(kind, input);
  if (copy.subject === null && copy.message === null) {
    await resetEmailCopy(ctx, actor, kind);
    return copy;
  }
  return inTransaction(ctx, async (tx) => {
    // Serializes two admins saving at once, so each audit row's `before` is what it replaced.
    if (!(await lockCompany(tx, actor.companyId))) throw new DomainError("no_company");
    await assertActiveAdmin(tx, actor);
    const row = await findEmailTemplate(tx, actor.companyId, kind);
    const before = row ? { subject: row.subject, message: row.message } : null;
    if (before && before.subject === copy.subject && before.message === copy.message) return copy;
    await upsertEmailTemplate(tx, actor.companyId, kind, copy);
    await record(tx, actor, ADMIN_EVENT_TYPES.emailTemplateUpdated, kind, before, copy);
    return copy;
  });
}

/**
 * Puts one email back to its default words. Doing it to an email already on its
 * defaults records nothing; otherwise records `email_template.reset`.
 *
 * @throws DomainError `forbidden`, `not_found` or `no_company`.
 */
export async function resetEmailCopy(ctx: ServiceContext, actor: Actor, type: string): Promise<void> {
  assertCanAdminister(actor);
  const kind = kindOf(type);
  await inTransaction(ctx, async (tx) => {
    if (!(await lockCompany(tx, actor.companyId))) throw new DomainError("no_company");
    await assertActiveAdmin(tx, actor);
    const row = await deleteEmailTemplate(tx, actor.companyId, kind);
    if (!row) return;
    await record(tx, actor, ADMIN_EVENT_TYPES.emailTemplateReset, kind, { subject: row.subject, message: row.message }, null);
  });
}

async function record(
  tx: Parameters<Parameters<typeof inTransaction>[1]>[0],
  actor: Actor,
  type: AdminEventType,
  kind: NotificationKind,
  before: EmailCopy | null,
  after: EmailCopy | null,
) {
  await recordAdminChange(tx, actor, { type, entityType: "email_template", entityId: kind, before, after, payload: payload(kind, after) });
}
