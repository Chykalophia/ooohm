"use server";

import { z } from "zod";
import { HOLIDAY_NAME_MAX_LENGTH } from "@/domain/holidays";
import { formatRecountOutcome } from "@/lib/format";
import { addHoliday, addUsFederalHolidays, deleteHoliday, renameHoliday } from "@/server/services/admin-holidays";
import type { FormState } from "@/components/forms/form-state";
import { adminAction } from "@/app/admin/admin-action";
import { formFields } from "@/app/_lib/form-fields";

const MESSAGES = {
  already_exists: "There's already a holiday on that date.",
  not_found: "That holiday doesn't exist any more.",
  invalid_input: "Pick a date and give the holiday a name.",
};

const nameField = formFields.text(HOLIDAY_NAME_MAX_LENGTH * 2);

/** The action's confirmation, followed by what the recount changed, if anything. */
function withRecount(done: string, recount: Parameters<typeof formatRecountOutcome>[0]): string {
  const changes = formatRecountOutcome(recount);
  return changes ? `${done} ${changes}` : done;
}

export async function addHolidayAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "holiday_add",
    formData,
    z.object({ date: formFields.text(10), name: nameField }),
    async (ctx, actor, input) => {
      const { holiday, recount } = await addHoliday(ctx, actor, input);
      return withRecount(`Added ${holiday.name}.`, recount);
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
      const { added, recount } = await addUsFederalHolidays(ctx, actor, year);
      if (added.length === 0) return "They're all here already.";
      return withRecount(`Added ${added.length} ${added.length === 1 ? "holiday" : "holidays"}.`, recount);
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
      return withRecount("Deleted.", await deleteHoliday(ctx, actor, id));
    },
    MESSAGES,
  );
}
