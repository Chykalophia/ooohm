"use server";

import { z } from "zod";
import { COMPANY_NAME_MAX_LENGTH } from "@/domain/company-settings";
import { formatRecountOutcome } from "@/lib/format";
import { updateCompanySettings } from "@/server/services/admin-company";
import type { FormState } from "@/components/forms/form-state";
import { adminAction } from "@/app/admin/admin-action";
import { formFields } from "@/app/_lib/form-fields";

const companySchema = z.object({
  name: formFields.text(COMPANY_NAME_MAX_LENGTH * 2),
  timezone: formFields.text(100),
  workingDays: z.array(z.coerce.number().int()).max(7),
  allowancePolicy: formFields.text(100),
  deletionGrace: formFields.checkbox,
  managersSeeDetails: formFields.checkbox,
  approvalMode: formFields.text(20).optional(),
  colleagueVisibility: formFields.text(20),
  departmentScoping: formFields.checkbox,
});

/** Company page: saves the name, time zone, working days, allowance policy, the deletion grace option, what people see of each other's time off, whether they are kept to their departments, what managers see of their reports, and whether time off needs approval. */
export async function updateCompanyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "company_update",
    { ...Object.fromEntries(formData), workingDays: formData.getAll("workingDays") },
    companySchema,
    async (ctx, actor, input) => {
      const { recount } = await updateCompanySettings(ctx, actor, input);
      const changes = formatRecountOutcome(recount);
      return changes ? `Saved. ${changes}` : "Saved.";
    },
    { invalid_input: "Give the company a name, pick a time zone from the list, tick at least one working day, and choose how time off is approved." },
  );
}
