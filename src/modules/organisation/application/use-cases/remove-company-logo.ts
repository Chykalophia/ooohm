import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import type { ServiceContext } from "@/server/context";
import { inTransaction } from "@/shared/lib/unit-of-work";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { changeCompany } from "@/modules/organisation/application/company-changes";
import type { CompanyDTO } from "@/modules/organisation/application/dto";
import { canManageAppearance } from "@/modules/organisation/application/policies";

/**
 * Removes the company's logo, bytes and all, so the OOOhm mark shows again. Emails
 * already sent lose their image and show the company's name instead.
 *
 * Returns the company after the change (unchanged, with nothing recorded, when it had no
 * logo). Fails with `forbidden` or `no_company`.
 */
export async function removeCompanyLogo(ctx: ServiceContext, actor: Actor): Promise<ServiceResult<CompanyDTO>> {
  if (!canManageAppearance(actor)) return err("forbidden");
  return attempt(() =>
    inTransaction(
      ctx,
      async (tx) =>
        (await changeCompany(tx, actor, () => ({ logo: null, logoSha256: null, logoType: null, logoWidth: null, logoHeight: null }))).after,
    ),
  );
}
