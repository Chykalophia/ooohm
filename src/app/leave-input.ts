import { z } from "zod";
import type { RequestCost } from "@/domain/allowance-policy";
import { DAY_PORTIONS, NOTE_MAX_LENGTH } from "@/domain/leave-request";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * The shape of a draft leave request as the form sends it, shared by the live
 * preview and submit so both accept exactly the same input. Shape only: the service
 * validates the dates and the leave type.
 */
export const leaveDraftSchema = z.object({
  leaveTypeId: z.string().min(1),
  startDate: isoDate,
  endDate: isoDate.or(z.literal("")).optional(),
  dayPortion: z.enum(DAY_PORTIONS).default("full"),
});

export const leaveRequestSchema = leaveDraftSchema.extend({
  note: z.string().max(NOTE_MAX_LENGTH).optional(),
});

/** Reads the draft fields from form data or query parameters; absent fields become `undefined`. */
export function readDraftFields(source: { get(name: string): FormDataEntryValue | null }) {
  return {
    leaveTypeId: source.get("leaveTypeId") ?? "",
    startDate: source.get("startDate") ?? "",
    endDate: source.get("endDate") ?? undefined,
    dayPortion: source.get("dayPortion") ?? undefined,
  };
}

/** Body of every `/api/leave-preview` response: a sentence to show, plus the numbers when the request is valid. */
export type LeavePreviewResponse = { ok: true; message: string; cost: RequestCost } | { ok: false; message: string };
