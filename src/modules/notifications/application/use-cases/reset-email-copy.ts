import "server-only";
import type { Actor } from "@/domain/actor";
import { ADMIN_EVENT_TYPES } from "@/domain/events";
import { DomainError } from "@/domain/errors";
import type { ServiceContext } from "@/server/context";
import { lockCompany } from "@/shared/lib/db/company-lock";
import { deleteEmailTemplate } from "@/modules/notifications/infrastructure/drizzle-email-templates.repository";
import { assertActiveAdmin } from "@/shared/lib/admin-access";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { inTransaction } from "@/shared/lib/unit-of-work";
import { kindOf, recordCopyChange } from "@/modules/notifications/application/email-editor";
import { canEditEmailCopy } from "@/modules/notifications/application/policies";

/**
 * Puts one email back to its default words. Doing it to an email already on its
 * defaults records nothing; otherwise records `email_template.reset`. Fails with
 * `forbidden`, `not_found` or `no_company`.
 */
export async function resetEmailCopy(ctx: ServiceContext, actor: Actor, type: string): Promise<ServiceResult<void>> {
  if (!canEditEmailCopy(actor)) return err("forbidden");
  return attempt(async () => {
    const kind = kindOf(type);
    await inTransaction(ctx, async (tx) => {
      if (!(await lockCompany(tx, actor.companyId))) throw new DomainError("no_company");
      await assertActiveAdmin(tx, actor);
      const row = await deleteEmailTemplate(tx, actor.companyId, kind);
      if (!row) return;
      await recordCopyChange(tx, actor, ADMIN_EVENT_TYPES.emailTemplateReset, kind, { subject: row.subject, message: row.message }, null);
    });
  });
}
