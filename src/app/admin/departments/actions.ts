"use server";

import { z } from "zod";
import { DEPARTMENT_NAME_MAX_LENGTH } from "@/domain/people";
import { createDepartment, deleteDepartment, renameDepartment } from "@/server/services/admin-departments";
import type { FormState } from "@/components/forms/form-state";
import { adminAction, formFields } from "@/app/admin/admin-action";

const MESSAGES = {
  already_exists: "There's already a department with that name.",
  not_found: "That department doesn't exist any more.",
  invalid_input: `Department names are 1 to ${DEPARTMENT_NAME_MAX_LENGTH} characters.`,
};

const nameField = formFields.text(DEPARTMENT_NAME_MAX_LENGTH * 2);

export async function createDepartmentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "department_create",
    formData,
    z.object({ name: nameField }),
    async (ctx, actor, { name }) => {
      const row = await createDepartment(ctx, actor, name);
      return `Added ${row.name}.`;
    },
    MESSAGES,
  );
}

export async function renameDepartmentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "department_rename",
    formData,
    z.object({ id: formFields.id, name: nameField }),
    async (ctx, actor, { id, name }) => {
      await renameDepartment(ctx, actor, id, name);
      return "Renamed.";
    },
    MESSAGES,
  );
}

export async function deleteDepartmentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "department_delete",
    formData,
    z.object({ id: formFields.id }),
    async (ctx, actor, { id }) => {
      await deleteDepartment(ctx, actor, id);
      return "Deleted.";
    },
    MESSAGES,
  );
}
