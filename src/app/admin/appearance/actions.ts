"use server";

import { z } from "zod";
import { updateCompanyAppearance } from "@/server/services/admin-company";
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
    async (ctx, actor, input) => {
      await updateCompanyAppearance(ctx, actor, {
        theme: input.theme,
        accentColor: input.customAccent ? (input.accentColor ?? "") : null,
        corners: input.corners,
        requestStyle: input.requestStyle,
        layout: input.layout,
      });
      return "Saved. Everyone sees the new look the next time a page fully loads.";
    },
    { invalid_input: "Pick one of the themes, a corner style, a request style and a layout from the lists, and an accent colour like #2546d0." },
  );
}
