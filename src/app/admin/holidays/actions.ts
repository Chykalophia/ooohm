"use server";

import { z } from "zod";
import { HOLIDAY_NAME_MAX_LENGTH, HOLIDAY_RANGE_MAX_DAYS } from "@/domain/holidays";
import { formatCount, formatDateSpan, formatRecountOutcome } from "@/lib/format";
import { addHoliday, addHolidayRange, addUsFederalHolidays, deleteHolidays, renameHolidays } from "@/server/services/admin-holidays";
import type { FormState } from "@/components/forms/form-state";
import { adminAction } from "@/app/admin/admin-action";
import { formFields } from "@/app/_lib/form-fields";

const MESSAGES = {
  already_exists: "There's already a holiday on that date.",
  not_found: "That holiday doesn't exist any more.",
  invalid_input: `Pick a first day, a last day on or after it (${HOLIDAY_RANGE_MAX_DAYS} days at most), and a name.`,
};

const nameField = formFields.text(HOLIDAY_NAME_MAX_LENGTH * 2);

/** The holiday's ids, comma-separated: one for a single day, one per day for a run. */
const idsField = z
  .string()
  .min(1)
  .max(4000)
  .transform((v) => v.split(",").filter(Boolean));

/** The action's confirmation, followed by what the recount changed, if anything. */
function withRecount(done: string, recount: Parameters<typeof formatRecountOutcome>[0]): string {
  const changes = formatRecountOutcome(recount);
  return changes ? `${done} ${changes}` : done;
}

export async function addHolidayAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "holiday_add",
    formData,
    z.object({ date: formFields.text(10), endDate: formFields.text(10).optional(), name: nameField }),
    async (ctx, actor, { date, endDate, name }) => {
      if (!endDate || endDate === date) {
        const { holiday, recount } = await addHoliday(ctx, actor, { date, name });
        return withRecount(`Added ${holiday.name}.`, recount);
      }
      const { added, skipped, recount } = await addHolidayRange(ctx, actor, { startDate: date, endDate, name });
      const kept = skipped.length > 0 ? ` ${formatCount(skipped.length, "day", "days")} already had a holiday and kept it.` : "";
      return withRecount(
        `Added ${added[0].name}, ${formatDateSpan(date, endDate)} (${formatCount(added.length, "day", "days")}).${kept}`,
        recount,
      );
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
    z.object({ ids: idsField, name: nameField }),
    async (ctx, actor, { ids, name }) => {
      await renameHolidays(ctx, actor, ids, name);
      return "Renamed.";
    },
    MESSAGES,
  );
}

export async function deleteHolidayAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "holiday_delete",
    formData,
    z.object({ ids: idsField }),
    async (ctx, actor, { ids }) => {
      return withRecount("Deleted.", await deleteHolidays(ctx, actor, ids));
    },
    MESSAGES,
  );
}
