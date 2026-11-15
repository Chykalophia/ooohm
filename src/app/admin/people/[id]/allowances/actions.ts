"use server";

import { z } from "zod";
import { NOTE_MAX_LENGTH } from "@/shared/kernel/leave-range";
import { map } from "@/shared/lib/result";
import { setAllowanceOverride } from "@/modules/balances";
import type { FormState } from "@/components/forms/form-state";
import { adminAction } from "@/app/admin/admin-action";
import { formFields } from "@/app/_lib/form-fields";
import { PERSON_MESSAGES } from "@/app/admin/people/person-input";

const allowanceSchema = z.object({
  userId: formFields.id,
  leaveTypeId: formFields.id,
  year: z.coerce.number().int(),
  days: formFields.number,
  adjustmentDays: formFields.number,
  reason: formFields.text(NOTE_MAX_LENGTH * 2),
});

/** Allowances page: sets one person's allowance for one leave type and year. */
export async function allowanceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "allowance_override",
    formData,
    allowanceSchema,
    async (ctx, actor, input) => {
      return map(await setAllowanceOverride(ctx, actor, input), ({ changed }) =>
        changed ? "Saved." : "Those are already the amounts, so nothing changed and nothing was recorded.",
      );
    },
    {
      ...PERSON_MESSAGES,
      invalid_input: "Days go from 0 to 366 in steps of 0.1, and a reason is required. Years before last year can't be changed.",
    },
  );
}
