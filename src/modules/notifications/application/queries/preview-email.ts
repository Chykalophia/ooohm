import "server-only";
import type { Actor } from "@/domain/actor";
import type { ServiceContext } from "@/server/context";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { emailAccentFor } from "@/modules/notifications/application/accent";
import { type EmailPreviewDTO, toEmailPreviewDTO } from "@/modules/notifications/application/dto";
import { kindOf, normalizeFor } from "@/modules/notifications/application/email-editor";
import { canEditEmailCopy } from "@/modules/notifications/application/policies";
import { previewNotification } from "@/modules/notifications/application/preview";

/**
 * The email as it would go out with `draft`, filled with made-up data and the company's
 * accent. Saves and sends nothing. Fails with `forbidden`, `not_found` or `invalid_input`
 * (as `saveEmailCopy`).
 */
export async function previewEmail(
  ctx: ServiceContext,
  actor: Actor,
  type: string,
  draft: { subject: string; message: string },
): Promise<ServiceResult<EmailPreviewDTO>> {
  if (!canEditEmailCopy(actor)) return err("forbidden");
  return attempt(async () => {
    const kind = kindOf(type);
    const copy = normalizeFor(kind, draft);
    return toEmailPreviewDTO(await previewNotification(kind, copy, await emailAccentFor(ctx, actor.companyId)()));
  });
}
