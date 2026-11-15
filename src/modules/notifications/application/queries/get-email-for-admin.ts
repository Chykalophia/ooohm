import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import type { ServiceContext } from "@/server/context";
import { findEmailTemplate } from "@/modules/notifications/infrastructure/drizzle-email-templates.repository";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { NOTIFICATION_TYPES } from "@/modules/notifications/application/catalog";
import { usableCopy } from "@/modules/notifications/application/copy";
import { type EmailEditorDTO, toEmailEditorDTO } from "@/modules/notifications/application/dto";
import { kindOf, labelOf } from "@/modules/notifications/application/email-editor";
import { canEditEmailCopy } from "@/modules/notifications/application/policies";

/**
 * One email for the editor: what it is, its variables, its defaults and the company's
 * saved words (`null` when it uses the defaults). A saved field that names a variable the
 * email no longer has is shown as the default, as it is sent, so the editor still opens
 * and saving or resetting replaces it. Fails with `forbidden` or `not_found`.
 */
export async function getEmailForAdmin(ctx: ServiceContext, actor: Actor, type: string): Promise<ServiceResult<EmailEditorDTO>> {
  if (!canEditEmailCopy(actor)) return err("forbidden");
  return attempt(async () => {
    const kind = kindOf(type);
    const row = await findEmailTemplate(ctx.db, actor.companyId, kind);
    const { copy } = NOTIFICATION_TYPES[kind];
    return toEmailEditorDTO({
      type: kind,
      ...labelOf(kind),
      variables: copy.variables,
      defaults: copy.defaults,
      saved: row ? usableCopy(kind, { subject: row.subject, message: row.message }) : null,
    });
  });
}
