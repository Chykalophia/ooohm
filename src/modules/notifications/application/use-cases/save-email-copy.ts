import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import type { EmailCopy } from "@/shared/kernel/email-template";
import { ADMIN_EVENT_TYPES } from "@/shared/kernel/events";
import { DomainError } from "@/shared/kernel/errors";
import type { ServiceContext } from "@/server/context";
import { lockCompany } from "@/shared/lib/db/company-lock";
import { findEmailTemplate, upsertEmailTemplate } from "@/modules/notifications/infrastructure/drizzle-email-templates.repository";
import { assertActiveAdmin } from "@/shared/lib/admin-access";
import { attempt, err, type ServiceResult, unwrap } from "@/shared/lib/result";
import { inTransaction } from "@/shared/lib/unit-of-work";
import { kindOf, normalizeFor, recordCopyChange } from "@/modules/notifications/application/email-editor";
import { canEditEmailCopy } from "@/modules/notifications/application/policies";
import { resetEmailCopy } from "@/modules/notifications/application/use-cases/reset-email-copy";

/**
 * Saves the company's words for one email. A blank field, or one typed exactly as the
 * default, uses the default; when both do, the email goes back to its defaults (as
 * `resetEmailCopy`). Saving what is already saved records nothing.
 *
 * Records `email_template.updated` (or `.reset`), with the words before and after.
 *
 * Returns the copy now in force (`null` fields are the defaults). Fails with `forbidden`,
 * `not_found`, `no_company`, or `invalid_input` with the field (`subject` or `message`)
 * that is too long or names a variable the email does not have.
 */
export async function saveEmailCopy(
  ctx: ServiceContext,
  actor: Actor,
  type: string,
  input: { subject: string; message: string },
): Promise<ServiceResult<EmailCopy>> {
  if (!canEditEmailCopy(actor)) return err("forbidden");
  return attempt(async () => {
    const kind = kindOf(type);
    const copy = normalizeFor(kind, input);
    if (copy.subject === null && copy.message === null) {
      unwrap(await resetEmailCopy(ctx, actor, kind));
      return copy;
    }
    return inTransaction(ctx, actor.companyId, async (tx) => {
      // Serializes two admins saving at once, so each audit row's `before` is what it replaced.
      if (!(await lockCompany(tx, actor.companyId))) throw new DomainError("no_company");
      await assertActiveAdmin(tx, actor);
      const row = await findEmailTemplate(tx, actor.companyId, kind);
      const before = row ? { subject: row.subject, message: row.message } : null;
      if (before && before.subject === copy.subject && before.message === copy.message) return copy;
      await upsertEmailTemplate(tx, actor.companyId, kind, copy);
      await recordCopyChange(tx, actor, ADMIN_EVENT_TYPES.emailTemplateUpdated, kind, before, copy);
      return copy;
    });
  });
}
