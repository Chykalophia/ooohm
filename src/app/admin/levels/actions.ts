"use server";

import { z } from "zod";
import { LEVEL_NAME_MAX_LENGTH } from "@/domain/people";
import { createLevel, deleteLevel, renameLevel } from "@/server/services/admin-levels";
import type { FormState } from "@/components/forms/form-state";
import { adminAction } from "@/app/admin/admin-action";
import { formFields } from "@/app/_lib/form-fields";

const MESSAGES = {
  already_exists: "There's already a level with that name.",
  not_found: "That level doesn't exist any more.",
  invalid_input: `Level names are 1 to ${LEVEL_NAME_MAX_LENGTH} characters.`,
};

const nameField = formFields.text(LEVEL_NAME_MAX_LENGTH * 2);

export async function createLevelAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "level_create",
    formData,
    z.object({ name: nameField }),
    async (ctx, actor, { name }) => {
      const row = await createLevel(ctx, actor, name);
      return `Added ${row.name}.`;
    },
    MESSAGES,
  );
}

export async function renameLevelAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "level_rename",
    formData,
    z.object({ id: formFields.id, name: nameField }),
    async (ctx, actor, { id, name }) => {
      await renameLevel(ctx, actor, id, name);
      return "Renamed.";
    },
    MESSAGES,
  );
}

export async function deleteLevelAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "level_delete",
    formData,
    z.object({ id: formFields.id }),
    async (ctx, actor, { id }) => {
      await deleteLevel(ctx, actor, id);
      return "Deleted.";
    },
    MESSAGES,
  );
}
