"use server";

import { z } from "zod";
import { LOGO_MAX_BYTES, LOGO_RULES } from "@/shared/kernel/company-logo";
import { DomainError } from "@/shared/kernel/errors";
import { removeCompanyLogo, updateCompanyAppearance, updateCompanyLogo } from "@/modules/organisation";
import { map } from "@/shared/lib/result";
import type { FormState } from "@/components/forms/form-state";
import { adminAction } from "@/app/admin/admin-action";
import { formFields } from "@/app/_lib/form-fields";

const appearanceSchema = z.object({
  theme: formFields.text(40),
  customAccent: formFields.checkbox,
  accentColor: formFields.text(20).optional(),
  corners: formFields.text(20),
  requestStyle: formFields.text(20),
  layout: formFields.text(20),
});

/** Appearance page: saves the company's theme, its optional accent colour, the corner style and the request style. */
export async function updateAppearanceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "appearance_update",
    formData,
    appearanceSchema,
    async (ctx, actor, input) =>
      map(
        await updateCompanyAppearance(ctx, actor, {
          theme: input.theme,
          accentColor: input.customAccent ? (input.accentColor ?? "") : null,
          corners: input.corners,
          requestStyle: input.requestStyle,
          layout: input.layout,
        }),
        () => "Saved. Everyone sees the new look the next time a page fully loads.",
      ),
    { invalid_input: "Pick one of the themes, a corner style, a request style and a layout from the lists, and an accent colour like #2546d0." },
  );
}

const logoSchema = z.object({ logo: z.instanceof(File) });

/** Appearance page: sets the company's logo from the uploaded file. */
export async function uploadLogoAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "logo_upload",
    formData,
    logoSchema,
    async (ctx, actor, input) => {
      // Refuse an oversized file before reading it into memory; the service checks the bytes again.
      if (input.logo.size > LOGO_MAX_BYTES) throw new DomainError("invalid_input", LOGO_RULES);
      return map(
        await updateCompanyLogo(ctx, actor, new Uint8Array(await input.logo.arrayBuffer())),
        () => "Saved. Your logo now shows in the header, on the sign-in page and in emails.",
      );
    },
    { invalid_input: `Pick a logo file. ${LOGO_RULES}` },
  );
}

/** Appearance page: removes the company's logo, so the OOOhm logo shows again. */
export async function removeLogoAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "logo_remove",
    formData,
    z.object({}),
    async (ctx, actor) => map(await removeCompanyLogo(ctx, actor), () => "Logo removed. The OOOhm logo is back."),
  );
}
