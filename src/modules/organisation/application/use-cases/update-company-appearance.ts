import "server-only";
import type { Actor } from "@/domain/actor";
import { type AppearanceInput, normalizeAppearance } from "@/domain/appearance";
import type { ServiceContext } from "@/server/context";
import { inTransaction } from "@/shared/lib/unit-of-work";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { changeCompany } from "@/modules/organisation/application/company-changes";
import type { CompanyDTO } from "@/modules/organisation/application/dto";
import { canManageAppearance } from "@/modules/organisation/application/policies";

/**
 * Saves the company's appearance: the theme everyone sees, an optional accent colour
 * and the corner style. It changes how the app looks for every person at once; nothing
 * about leave or balances.
 *
 * Returns the company after the change (unchanged, with nothing recorded, when nothing
 * differs). Fails with `forbidden`, `no_company`, or `invalid_input`.
 */
export async function updateCompanyAppearance(ctx: ServiceContext, actor: Actor, input: AppearanceInput): Promise<ServiceResult<CompanyDTO>> {
  if (!canManageAppearance(actor)) return err("forbidden");
  return attempt(() => inTransaction(ctx, async (tx) => (await changeCompany(tx, actor, () => normalizeAppearance(input))).after));
}
