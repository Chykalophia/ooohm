/**
 * Admin use cases for the company's own settings: name, time zone, working days, the
 * allowance policy, the deletion grace option and the appearance (theme, accent, corners, logo). v1 runs one company per deployment;
 * the company is always the actor's.
 */
import type { Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { createHash } from "node:crypto";
import { type AppearanceInput, normalizeAppearance, readAppearance } from "@/domain/appearance";
import { readLogoImage, readStoredLogo } from "@/domain/company-logo";
import { assertCanAdminister } from "@/domain/admin-permissions";
import { ALLOWANCE_POLICY_KEYS } from "@/domain/allowance-policy";
import { type CompanySettingsInput, normalizeCompanySettings, supportedTimeZones } from "@/domain/company-settings";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES, type CompanyEventPayload, type Unattributed } from "@/domain/events";
import type { ServiceContext } from "@/server/context";
import { type CompanyRow, findCompany, lockCompany, updateCompany } from "@/server/repositories/companies";
import { assertActiveAdmin, recordAdminChange } from "./admin-access";
import { NOTHING_RECOUNTED, type RecountOutcome, recountLeave } from "./leave-recount";
import { commitThenSend, inTransaction } from "./notify";

function snapshot(row: CompanyRow) {
  return {
    name: row.name,
    timezone: row.timezone,
    workingDays: row.workingDays,
    allowancePolicy: row.allowancePolicy,
    deletionGrace: row.deletionGrace,
    managersSeeDetails: row.managersSeeDetails,
    ...readAppearance(row),
    logo: readStoredLogo(row),
  };
}

/**
 * Inside `tx`: locks the company, checks the actor is still an active admin, applies
 * `change` (after that check, so input is only judged for an admin) and, when anything
 * differs, saves it and records `company.updated` with the audit row.
 *
 * @returns The company before and after; `changed` is false (nothing written or
 *   recorded) when the change leaves it as it was.
 * @throws DomainError `no_company`, `forbidden`, or whatever `change` throws.
 */
async function changeCompany(
  tx: Transaction,
  actor: Actor,
  change: (before: CompanyRow) => Parameters<typeof updateCompany>[2],
): Promise<{ before: CompanyRow; after: CompanyRow; changed: boolean }> {
  const before = await lockCompany(tx, actor.companyId);
  if (!before) throw new DomainError("no_company");
  await assertActiveAdmin(tx, actor);
  const settings = change(before);
  if (JSON.stringify(snapshot({ ...before, ...settings })) === JSON.stringify(snapshot(before))) return { before, after: before, changed: false };
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
  return { before, after, changed: true };
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
    const { before, after, changed } = await changeCompany(tx, actor, (b) => ({
      deletionGrace: b.deletionGrace,
      managersSeeDetails: b.managersSeeDetails,
      ...normalizeCompanySettings(input, b.timezone),
    }));
    const workingDaysChanged = JSON.stringify(after.workingDays) !== JSON.stringify(before.workingDays);
    if (!changed || !workingDaysChanged) return { result: { company: after, recount: NOTHING_RECOUNTED }, outgoing: [] };
    const { outcome, outgoing } = await recountLeave(tx, ctx, actor, { kind: "working_days", previous: before.workingDays });
    return { result: { company: after, recount: outcome }, outgoing };
  });
}

/**
 * Saves the company's appearance: the theme everyone sees, an optional accent colour
 * and the corner style. It changes how the app looks for every person at once; nothing
 * about leave or balances.
 *
 * @returns The company after the change (unchanged, with nothing recorded, when nothing differs).
 * @throws DomainError `forbidden`, `no_company`, or `invalid_input`.
 */
export async function updateCompanyAppearance(ctx: ServiceContext, actor: Actor, input: AppearanceInput): Promise<CompanyRow> {
  assertCanAdminister(actor);
  return inTransaction(ctx, async (tx) => (await changeCompany(tx, actor, () => normalizeAppearance(input))).after);
}

/**
 * Sets the company's logo, shown instead of the OOOhm mark in the header, on the
 * sign-in page and at the top of emails. The file is judged by its bytes
 * ({@link readLogoImage}), and only after the actor is known to be an admin.
 *
 * @returns The company after the change (unchanged, with nothing recorded, for the same file).
 * @throws DomainError `forbidden`, `no_company`, or `invalid_input` (not a PNG or JPEG within the limits).
 */
export async function updateCompanyLogo(ctx: ServiceContext, actor: Actor, bytes: Uint8Array): Promise<CompanyRow> {
  assertCanAdminister(actor);
  return inTransaction(ctx, async (tx) => {
    const result = await changeCompany(tx, actor, () => {
      const image = readLogoImage(bytes);
      return {
        logo: bytes,
        logoSha256: createHash("sha256").update(bytes).digest("hex"),
        logoType: image.contentType,
        logoWidth: image.width,
        logoHeight: image.height,
      };
    });
    return result.after;
  });
}

/**
 * Removes the company's logo, bytes and all, so the OOOhm mark shows again. Emails
 * already sent lose their image and show the company's name instead.
 *
 * @returns The company after the change (unchanged, with nothing recorded, when it had no logo).
 * @throws DomainError `forbidden` or `no_company`.
 */
export async function removeCompanyLogo(ctx: ServiceContext, actor: Actor): Promise<CompanyRow> {
  assertCanAdminister(actor);
  return inTransaction(
    ctx,
    async (tx) =>
      (await changeCompany(tx, actor, () => ({ logo: null, logoSha256: null, logoType: null, logoWidth: null, logoHeight: null }))).after,
  );
}
