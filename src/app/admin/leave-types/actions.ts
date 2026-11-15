"use server";

import { z } from "zod";
import { LEAVE_TYPE_CODE_MAX_LENGTH, LEAVE_TYPE_NAME_MAX_LENGTH } from "@/shared/kernel/leave-type-settings";
import { createLeaveType, reorderLeaveTypes, setLeaveTypeArchived, updateLeaveType } from "@/modules/organisation";
import { map } from "@/shared/lib/result";
import type { FormState } from "@/components/forms/form-state";
import { adminAction } from "@/app/admin/admin-action";
import { formFields } from "@/app/_lib/form-fields";

const MESSAGES = {
  already_exists: "Another leave type already uses that code.",
  not_found: "That leave type doesn't exist any more.",
  invalid_input: "Check the code (letters and digits), the colour, and that day amounts are 0 or more in steps of 0.1.",
};

const settingsSchema = z.object({
  name: formFields.text(LEAVE_TYPE_NAME_MAX_LENGTH * 2),
  code: formFields.text(LEAVE_TYPE_CODE_MAX_LENGTH * 2),
  color: formFields.text(20),
  isPaid: formFields.checkbox,
  countsAgainstAllowance: formFields.checkbox,
  defaultAllowanceDays: formFields.optionalNumber,
  carryoverEnabled: formFields.checkbox,
  carryoverMaxDays: formFields.optionalNumber,
});

export async function createLeaveTypeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "leave_type_create",
    formData,
    settingsSchema,
    async (ctx, actor, input) =>
      map(await createLeaveType(ctx, actor, input), (type) => `Added ${type.name}. It's last in the request form; move it from the list.`),
    MESSAGES,
  );
}

export async function updateLeaveTypeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "leave_type_update",
    formData,
    settingsSchema.extend({ id: formFields.id }),
    async (ctx, actor, { id, ...input }) => map(await updateLeaveType(ctx, actor, id, input), () => "Saved."),
    MESSAGES,
  );
}

export async function archiveLeaveTypeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "leave_type_archive",
    formData,
    z.object({ id: formFields.id, archived: z.enum(["true", "false"]) }),
    async (ctx, actor, { id, archived }) =>
      map(await setLeaveTypeArchived(ctx, actor, id, archived === "true"), () => (archived === "true" ? "Archived." : "Restored.")),
    MESSAGES,
  );
}

/**
 * Saves the order the leave types were dragged into: every active type's id, first to
 * last. Takes the list itself, not a form: it is sent by the sortable list on drop.
 */
export async function reorderLeaveTypesAction(order: string[]): Promise<FormState> {
  return adminAction(
    "leave_type_reorder",
    { order },
    z.object({ order: z.array(formFields.id).min(1).max(200) }),
    async (ctx, actor, { order }) => map(await reorderLeaveTypes(ctx, actor, order), (moved) => (moved ? "Order saved." : "Already in that order.")),
    {
      ...MESSAGES,
      invalid_input: "That order couldn't be read. Reload the page and try again.",
      conflict: "The leave types changed since this page loaded. The list is up to date now; try again.",
    },
  );
}
