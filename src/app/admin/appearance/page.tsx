import type { Metadata } from "next";
import { readAppearance } from "@/shared/kernel/appearance";
import { appLogoRef, readStoredLogo } from "@/shared/kernel/company-logo";
import { getCompanySettings } from "@/modules/organisation";
import { unwrap } from "@/shared/lib/result";
import { AdminShell } from "@/app/admin/admin-shell";
import { requireAdminPage } from "@/app/_lib/page-context";
import { AppearanceForm } from "./appearance-form";
import { LogoSection } from "./logo-section";

export const metadata: Metadata = { title: "Appearance · Admin · OOOhm" };

export default async function AppearancePage() {
  const { actor, ctx, nav } = await requireAdminPage();
  const { company } = unwrap(await getCompanySettings(ctx, actor));
  const stored = readStoredLogo(company);

  return (
    <AdminShell
      nav={nav}
      section="appearance"
      title="Appearance"
      description="Choose how OOOhm looks for everyone in your company. People can’t change it for themselves, so pick what fits your team."
    >
      <LogoSection logo={stored ? appLogoRef(stored, company.name) : null} />
      <AppearanceForm current={readAppearance(company)} />
    </AdminShell>
  );
}
