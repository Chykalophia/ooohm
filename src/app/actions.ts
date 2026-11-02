"use server";

import { randomUUID } from "node:crypto";
import { refresh } from "next/cache";
import { z } from "zod";
import { DAY_PORTIONS, NOTE_MAX_LENGTH } from "@/domain/leave-request";
import { requireActor } from "@/lib/auth";
import { serviceContext } from "@/server/runtime";
import { cancelLeaveRequest, submitLeaveRequest } from "@/server/services/leave-requests";
import type { FormState } from "./form-state";
import { messageFor, runAction } from "./run-action";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const requestSchema = z.object({
  leaveTypeId: z.string().min(1),
  startDate: isoDate,
  endDate: isoDate.or(z.literal("")).optional(),
  dayPortion: z.enum(DAY_PORTIONS).default("full"),
  note: z.string().max(NOTE_MAX_LENGTH).optional(),
});

/** Dashboard form: asks for time off as the signed-in user. */
export async function requestLeaveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { actor } = await requireActor();
  if (!actor) return { status: "error", message: messageFor("no_company") };

  const parsed = requestSchema.safeParse({
    leaveTypeId: formData.get("leaveTypeId") ?? "",
    startDate: formData.get("startDate") ?? "",
    endDate: formData.get("endDate") ?? undefined,
    dayPortion: formData.get("dayPortion") ?? undefined,
    note: formData.get("note") ?? undefined,
  });
  if (!parsed.success) return { status: "error", message: messageFor("invalid_input") };

  const state = await runAction("leave_request_submit", async () => {
    const request = await submitLeaveRequest(serviceContext(), actor, parsed.data);
    return {
      id: randomUUID(),
      message: request.status === "approved" ? "Approved. Enjoy your time off." : "Sent for approval.",
    };
  });
  if (state.status === "success") refresh();
  return state;
}

/** Cancels one of the signed-in user's own requests. */
export async function cancelLeaveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { actor } = await requireActor();
  if (!actor) return { status: "error", message: messageFor("no_company") };

  const requestId = String(formData.get("requestId") ?? "");
  const state = await runAction("leave_request_cancel", async () => {
    await cancelLeaveRequest(serviceContext(), actor, requestId);
    return { id: randomUUID(), message: "Cancelled." };
  });
  if (state.status === "success") refresh();
  return state;
}
