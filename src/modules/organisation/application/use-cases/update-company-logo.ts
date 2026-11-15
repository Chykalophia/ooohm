import "server-only";
import { createHash } from "node:crypto";
import type { Actor } from "@/shared/kernel/actor";
import { readLogoImage } from "@/shared/kernel/company-logo";
import type { ServiceContext } from "@/server/context";
import { inTransaction } from "@/shared/lib/unit-of-work";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { changeCompany } from "@/modules/organisation/application/company-changes";
import type { CompanyDTO } from "@/modules/organisation/application/dto";
import { canManageAppearance } from "@/modules/organisation/application/policies";

/**
 * Sets the company's logo, shown instead of the OOOhm mark in the header, on the
 * sign-in page and at the top of emails. The file is judged by its bytes
 * ({@link readLogoImage}), and only after the actor is known to be an admin.
 *
 * Returns the company after the change (unchanged, with nothing recorded, for the same
 * file). Fails with `forbidden`, `no_company`, or `invalid_input` (not a PNG or JPEG
 * within the limits).
 */
export async function updateCompanyLogo(ctx: ServiceContext, actor: Actor, bytes: Uint8Array): Promise<ServiceResult<CompanyDTO>> {
  if (!canManageAppearance(actor)) return err("forbidden");
  return attempt(() =>
    inTransaction(ctx, actor.companyId, async (tx) => {
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
    }),
  );
}
