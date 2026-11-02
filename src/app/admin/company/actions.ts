"use server";

import { z } from "zod";
import { COMPANY_NAME_MAX_LENGTH } from "@/domain/company-settings";
import { updateCompanySettings } from "@/server/services/admin-company";
import type { FormState } from "@/app/form-state";
import { adminAction, formFields } from "@/app/admin/admin-action";

const companySchema = z.object({
  name: formFields.text(COMPANY_NAME_MAX_LENGTH * 2),
  timezone: formFields.text(100),
  workingDays: z.array(z.coerce.number().int()).max(7),
  allowancePolicy: formFields.text(100),
  deletionGrace: formFields.checkbox,
});

/** Company page: saves the name, time zone, working days, allowance policy and the deletion grace option. */
export async function updateCompanyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "company_update",
    { ...Object.fromEntries(formData), workingDays: formData.getAll("workingDays") },
    companySchema,
    async (ctx, actor, input) => {
      await updateCompanySettings(ctx, actor, input);
      return "Saved.";
    },
    { invalid_input: "Give the company a name, pick a time zone from the list, and tick at least one working day." },
  );
}
