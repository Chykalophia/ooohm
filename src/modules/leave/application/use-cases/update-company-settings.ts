import "server-only";
/**
 * Saving the company's settings, with what new working days do to leave already sent.
 *
 * The settings belong to the organisation module (its `saveCompanySettings` step); the
 * recount belongs to leave, which reads organisation. This use case joins the two in one
 * unit of work, so organisation never depends on leave or on email.
 */
import type { Actor } from "@/domain/actor";
import type { CompanySettingsInput } from "@/domain/company-settings";
import { canManageCompanySettings, type CompanyChange, type CompanyDTO } from "@/modules/organisation";
import type { Notification } from "@/modules/notifications";
import { attempt, err, type ServiceResult, unwrap } from "@/shared/lib/result";
import type { LeaveDeps, LeaveStore } from "../ports";
import { NOTHING_RECOUNTED, type RecountOutcome, recountLeave } from "./recount-leave";

/** Organisation's settings step, bound to the unit of work's transaction. */
export interface CompanySettingsWriter {
  save(actor: Actor, input: CompanySettingsInput): Promise<CompanyChange>;
}

/** What {@link updateCompanySettings} needs: leave's dependencies and one transaction holding both steps. */
export interface UpdateCompanySettingsDeps {
  leave: LeaveDeps;
  /** Runs `work` in one transaction with the settings step and leave's ports bound to it; its emails go out after commit. */
  unitOfWork<T>(companyId: string, work: (settings: CompanySettingsWriter, store: LeaveStore) => Promise<{ result: T; notify: Notification[] }>): Promise<T>;
}

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
  deps: UpdateCompanySettingsDeps,
  actor: Actor,
  input: CompanySettingsInput,
): Promise<ServiceResult<{ company: CompanyDTO; recount: RecountOutcome }>> {
  if (!canManageCompanySettings(actor)) return err("forbidden");
  return attempt(() =>
    deps.unitOfWork(actor.companyId, async (settings, store) => {
      const { before, after, changed } = await settings.save(actor, input);
      const workingDaysChanged = JSON.stringify(after.workingDays) !== JSON.stringify(before.workingDays);
      if (!changed || !workingDaysChanged) return { result: { company: after, recount: NOTHING_RECOUNTED }, notify: [] };
      const { outcome, notify } = unwrap(await recountLeave(deps.leave, store, actor, { kind: "working_days", previous: before.workingDays }));
      return { result: { company: after, recount: outcome }, notify };
    }),
  );
}
