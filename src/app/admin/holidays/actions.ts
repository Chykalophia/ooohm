"use server";

import { z } from "zod";
import { HOLIDAY_NAME_MAX_LENGTH } from "@/domain/holidays";
import { addHoliday, addUsFederalHolidays, deleteHoliday, renameHoliday } from "@/server/services/admin-holidays";
import type { FormState } from "@/app/form-state";
import { adminAction, formFields } from "@/app/admin/admin-action";

const MESSAGES = {
  already_exists: "There's already a holiday on that date.",
  not_found: "That holiday doesn't exist any more.",
  invalid_input: "Pick a date and give the holiday a name.",
};

const nameField = formFields.text(HOLIDAY_NAME_MAX_LENGTH * 2);

export async function addHolidayAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "holiday_add",
    formData,
    z.object({ date: formFields.text(10), name: nameField }),
    async (ctx, actor, input) => {
      const row = await addHoliday(ctx, actor, input);
      return `Added ${row.name}.`;
    },
    MESSAGES,
  );
}

export async function addFederalHolidaysAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "holiday_add_federal",
    formData,
    z.object({ year: z.coerce.number().int() }),
    async (ctx, actor, { year }) => {
      const added = await addUsFederalHolidays(ctx, actor, year);
      return added.length === 0 ? "They're all here already." : `Added ${added.length} ${added.length === 1 ? "holiday" : "holidays"}.`;
    },
    MESSAGES,
  );
}

export async function renameHolidayAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "holiday_rename",
    formData,
    z.object({ id: formFields.id, name: nameField }),
    async (ctx, actor, { id, name }) => {
      await renameHoliday(ctx, actor, id, name);
      return "Renamed.";
    },
    MESSAGES,
  );
}

export async function deleteHolidayAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "holiday_delete",
    formData,
    z.object({ id: formFields.id }),
    async (ctx, actor, { id }) => {
      await deleteHoliday(ctx, actor, id);
      return "Deleted.";
    },
    MESSAGES,
  );
}
