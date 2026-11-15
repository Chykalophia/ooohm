import "server-only";
import { type LogoRef, appLogoRef, readStoredLogo } from "@/shared/kernel/company-logo";
import type { CompanyDTO } from "@/modules/organisation/application/dto";

/** The company's logo as the header draws it, or null for the OOOhm mark. */
export function logoRef(company: Pick<CompanyDTO, "name" | "logoSha256" | "logoType" | "logoWidth" | "logoHeight"> | undefined): LogoRef | null {
  const logo = company ? readStoredLogo(company) : null;
  return company && logo ? appLogoRef(logo, company.name) : null;
}
