"use server";

import { z } from "zod";
import { updateCompanyAppearance } from "@/server/services/admin-company";
import type { FormState } from "@/app/form-state";
import { adminAction, formFields } from "@/app/admin/admin-action";

const appearanceSchema = z.object({
  theme: formFields.text(40),
  customAccent: formFields.checkbox,
  accentColor: formFields.text(20).optional(),
  corners: formFields.text(20),
});

/** Appearance page: saves the company's theme, its optional accent colour and the corner style. */
export async function updateAppearanceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "appearance_update",
    Object.fromEntries(formData),
    appearanceSchema,
    async (ctx, actor, input) => {
      await updateCompanyAppearance(ctx, actor, {
        theme: input.theme,
        accentColor: input.customAccent ? (input.accentColor ?? "") : null,
        corners: input.corners,
      });
      return "Saved. Everyone sees the new look on their next page.";
    },
    { invalid_input: "Pick one of the themes, a corner style from the list, and an accent colour like #2546d0." },
  );
}
