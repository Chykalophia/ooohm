/**
 * Admin use cases for the company's own settings: name, time zone, working days, the
 * allowance policy and the deletion grace option. v1 runs one company per deployment;
 * the company is always the actor's.
 */
import type { Actor } from "@/domain/actor";
import { assertCanAdminister } from "@/domain/admin-permissions";
import { ALLOWANCE_POLICY_KEYS } from "@/domain/allowance-policy";
import { type CompanySettingsInput, normalizeCompanySettings, supportedTimeZones } from "@/domain/company-settings";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES, type CompanyEventPayload, type Unattributed } from "@/domain/events";
import type { ServiceContext } from "@/server/context";
import { type CompanyRow, findCompany, lockCompany, updateCompany } from "@/server/repositories/companies";
import { assertActiveAdmin, recordAdminChange } from "./admin-access";
import { NOTHING_RECOUNTED, type RecountOutcome, recountLeave } from "./leave-recount";
import { commitThenSend } from "./notify";

function snapshot(row: CompanyRow) {
  return {
    name: row.name,
    timezone: row.timezone,
    workingDays: row.workingDays,
    allowancePolicy: row.allowancePolicy,
    deletionGrace: row.deletionGrace,
  };
}

/**
 * The company's settings and the choices the form offers: every supported time zone
 * (plus the stored one, should it be an alias outside that list) and every registered
 * allowance policy.
 *
 * @throws DomainError `forbidden` or `no_company`.
 */
export async function getCompanySettings(ctx: ServiceContext, actor: Actor) {
  assertCanAdminister(actor);
  const company = await findCompany(ctx.db, actor.companyId);
  if (!company) throw new DomainError("no_company");
  const zones = [...supportedTimeZones()];
  if (!zones.includes(company.timezone)) zones.push(company.timezone);
  return { company, timeZones: zones.sort(), allowancePolicies: [...ALLOWANCE_POLICY_KEYS] };
}

/**
 * Saves the company's settings. A new time zone changes which day is "today" from now
 * on. New working days change how days are counted, so the pending and approved
 * requests in years still open are recounted with them ({@link recountLeave}); past
 * years keep their counts.
 *
 * @returns The settings after the change (unchanged, with nothing recorded, when nothing
 *   differs) and what the recount changed.
 * @throws DomainError `forbidden`, `no_company`, `invalid_input`, or as {@link recountLeave}.
 */
export async function updateCompanySettings(
  ctx: ServiceContext,
  actor: Actor,
  input: CompanySettingsInput,
): Promise<{ company: CompanyRow; recount: RecountOutcome }> {
  assertCanAdminister(actor);
  return commitThenSend(ctx, async (tx) => {
    const before = await lockCompany(tx, actor.companyId);
    if (!before) throw new DomainError("no_company");
    await assertActiveAdmin(tx, actor);
    const settings = { deletionGrace: before.deletionGrace, ...normalizeCompanySettings(input, before.timezone) };
    if (JSON.stringify(snapshot({ ...before, ...settings })) === JSON.stringify(snapshot(before))) {
      return { result: { company: before, recount: NOTHING_RECOUNTED }, outgoing: [] };
    }
    const after = await updateCompany(tx, actor.companyId, settings);
    const payload: Unattributed<CompanyEventPayload> = { companyId: after.id, ...snapshot(after) };
    await recordAdminChange(tx, actor, {
      type: ADMIN_EVENT_TYPES.companyUpdated,
      entityType: "company",
      entityId: after.id,
      before: snapshot(before),
      after: snapshot(after),
      payload,
    });
    const workingDaysChanged = JSON.stringify(after.workingDays) !== JSON.stringify(before.workingDays);
    if (!workingDaysChanged) return { result: { company: after, recount: NOTHING_RECOUNTED }, outgoing: [] };
    const { outcome, outgoing } = await recountLeave(tx, ctx, actor, { kind: "working_days", previous: before.workingDays });
    return { result: { company: after, recount: outcome }, outgoing };
  });
}
