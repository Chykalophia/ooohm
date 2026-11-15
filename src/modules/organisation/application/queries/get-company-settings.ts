import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { ALLOWANCE_POLICY_KEYS } from "@/shared/kernel/allowance-policy-keys";
import { supportedTimeZones } from "@/shared/kernel/company-settings";
import type { ServiceContext } from "@/server/context";
import { err, ok, type ServiceResult } from "@/shared/lib/result";
import { findCompany } from "@/modules/organisation/infrastructure/drizzle-companies.repository";
import { type CompanySettingsFormDTO, toCompanyDTO } from "@/modules/organisation/application/dto";
import { canManageCompanySettings } from "@/modules/organisation/application/policies";

/**
 * The company's settings and the choices the form offers: every supported time zone
 * (plus the stored one, should it be an alias outside that list) and every registered
 * allowance policy. Fails with `forbidden` or `no_company`.
 */
export async function getCompanySettings(ctx: ServiceContext, actor: Actor): Promise<ServiceResult<CompanySettingsFormDTO>> {
  if (!canManageCompanySettings(actor)) return err("forbidden");
  const company = await findCompany(ctx.db, actor.companyId);
  if (!company) return err("no_company");
  const zones = [...supportedTimeZones()];
  if (!zones.includes(company.timezone)) zones.push(company.timezone);
  return ok({ company: toCompanyDTO(company), timeZones: zones.sort(), allowancePolicies: [...ALLOWANCE_POLICY_KEYS] });
}
