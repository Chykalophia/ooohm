import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import type { ServiceContext } from "@/server/context";
import { listEmailTemplates } from "@/modules/notifications/infrastructure/drizzle-email-templates.repository";
import { err, ok, type ServiceResult } from "@/shared/lib/result";
import { type EmailListItemDTO, toEmailListItemDTO } from "@/modules/notifications/application/dto";
import { KINDS, labelOf } from "@/modules/notifications/application/email-editor";
import { canEditEmailCopy } from "@/modules/notifications/application/policies";

/** Every email the company sends, in the editor's order, and whether it has its own words. Fails with `forbidden`. */
export async function listEmailsForAdmin(ctx: ServiceContext, actor: Actor): Promise<ServiceResult<EmailListItemDTO[]>> {
  if (!canEditEmailCopy(actor)) return err("forbidden");
  const saved = new Set((await listEmailTemplates(ctx.db, actor.companyId)).map((r) => r.type));
  return ok(KINDS.map((type) => toEmailListItemDTO({ type, ...labelOf(type), customized: saved.has(type) })));
}
