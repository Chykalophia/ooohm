import "server-only";
/**
 * Saving the company's settings, with what new working days do to leave already sent.
 *
 * The settings belong to the organisation module (`saveCompanySettings`); the recount
 * belongs to leave, which reads organisation. This use case joins the two in one
 * transaction, so organisation never depends on leave or on email.
 */
import type { Actor } from "@/domain/actor";
import type { CompanySettingsInput } from "@/domain/company-settings";
import type { ServiceContext } from "@/server/context";
import { canManageCompanySettings, type CompanyDTO, saveCompanySettings } from "@/modules/organisation";
import { commitThenNotify } from "@/modules/notifications";
import { attempt, err, type ServiceResult, unwrap } from "@/shared/lib/result";
import { NOTHING_RECOUNTED, type RecountOutcome, recountLeave } from "@/modules/leave";

/**
 * Saves the company's settings. A new time zone changes which day is "today" from now
 * on. New working days change how days are counted, so the pending and approved
 * requests in years still open are recounted with them ({@link recountLeave}); past
 * years keep their counts. Turning approval off (`approvalMode: "heads_up"`) applies to
 * requests sent from then on: requests already waiting stay with their approver.
 *
 * Returns the settings after the change (unchanged, with nothing recorded, when nothing
 * differs) and what the recount changed. Fails with `forbidden`, `no_company`,
 * `invalid_input`, or as {@link recountLeave}.
 */
export async function updateCompanySettings(
  ctx: ServiceContext,
  actor: Actor,
  input: CompanySettingsInput,
): Promise<ServiceResult<{ company: CompanyDTO; recount: RecountOutcome }>> {
  if (!canManageCompanySettings(actor)) return err("forbidden");
  return attempt(() =>
    commitThenNotify(ctx, actor.companyId, async (tx) => {
      const { before, after, changed } = await saveCompanySettings(tx, actor, input);
      const workingDaysChanged = JSON.stringify(after.workingDays) !== JSON.stringify(before.workingDays);
      if (!changed || !workingDaysChanged) return { result: { company: after, recount: NOTHING_RECOUNTED }, notify: [] };
      const { outcome, notify } = unwrap(await recountLeave(tx, ctx, actor, { kind: "working_days", previous: before.workingDays }));
      return { result: { company: after, recount: outcome }, notify };
    }),
  );
}
