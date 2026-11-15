"use server";

import { z } from "zod";
import { DEPARTMENT_NAME_MAX_LENGTH } from "@/shared/kernel/names";
import { MAX_OFF_LIMIT } from "@/modules/leave";
import { createDepartment, deleteDepartment, renameDepartment, setDepartmentLimit } from "@/modules/organisation";
import { setDepartmentManager } from "@/server/services/department-manager";
import { map } from "@/shared/lib/result";
import { formatCount } from "@/lib/format";
import type { FormState } from "@/components/forms/form-state";
import { adminAction } from "@/app/admin/admin-action";
import { formFields } from "@/app/_lib/form-fields";

const MESSAGES = {
  already_exists: "There's already a department with that name.",
  not_found: "That department doesn't exist any more.",
  invalid_input: `Department names are 1 to ${DEPARTMENT_NAME_MAX_LENGTH} characters.`,
  invalid_manager: "Pick someone who's active in the company.",
};

const LIMIT_MESSAGES = { ...MESSAGES, invalid_input: `Use a whole number from 1 to ${MAX_OFF_LIMIT}, or leave it blank for no limit.` };

const nameField = formFields.text(DEPARTMENT_NAME_MAX_LENGTH * 2);

export async function createDepartmentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "department_create",
    formData,
    z.object({ name: nameField }),
    async (ctx, actor, { name }) => map(await createDepartment(ctx, actor, name), (department) => `Added ${department.name}.`),
    MESSAGES,
  );
}

export async function renameDepartmentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "department_rename",
    formData,
    z.object({ id: formFields.id, name: nameField }),
    async (ctx, actor, { id, name }) => map(await renameDepartment(ctx, actor, id, name), () => "Renamed."),
    MESSAGES,
  );
}

export async function deleteDepartmentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "department_delete",
    formData,
    z.object({ id: formFields.id }),
    async (ctx, actor, { id }) => map(await deleteDepartment(ctx, actor, id), () => "Deleted."),
    MESSAGES,
  );
}

export async function setDepartmentManagerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "department_manager",
    formData,
    z.object({ id: formFields.id, managerId: formFields.optionalId }),
    async (ctx, actor, { id, managerId }) =>
      map(await setDepartmentManager(ctx, actor, id, managerId), (result) => {
        const moved = result.requestsReassigned > 0 ? ` ${formatCount(result.requestsReassigned, "waiting request", "waiting requests")} moved to the new approver.` : "";
        return `Saved.${moved}`;
      }),
    MESSAGES,
  );
}

export async function setDepartmentLimitAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "department_limit",
    formData,
    z.object({ id: formFields.id, maxOff: formFields.optionalNumber }),
    async (ctx, actor, { id, maxOff }) =>
      map(await setDepartmentLimit(ctx, actor, id, maxOff), (department) =>
        department.maxOff === null ? "Saved. No limit." : `Saved. People get a warning past ${formatCount(department.maxOff, "person", "people")} off at once.`,
      ),
    LIMIT_MESSAGES,
  );
}
