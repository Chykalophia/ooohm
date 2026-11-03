"use server";

import { randomUUID } from "node:crypto";
import { refresh } from "next/cache";
import { requireActor } from "@/lib/auth";
import { formatSubmitted } from "@/lib/format";
import { serviceContext } from "@/server/runtime";
import { cancelLeaveRequest, submitLeaveRequest } from "@/server/services/leave-requests";
import type { FormState } from "./form-state";
import { leaveRequestSchema, readDraftFields } from "./leave-input";
import { messageFor, runAction } from "./run-action";

/** Dashboard form: asks for time off as the signed-in user. */
export async function requestLeaveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { actor } = await requireActor();
  if (!actor) return { status: "error", message: messageFor("no_company") };

  const parsed = leaveRequestSchema.safeParse({ ...readDraftFields(formData), note: formData.get("note") ?? undefined });
  if (!parsed.success) return { status: "error", message: messageFor("invalid_input") };

  const state = await runAction("leave_request_submit", async () => {
    const request = await submitLeaveRequest(serviceContext(), actor, parsed.data);
    return {
      id: randomUUID(),
      message: formatSubmitted({ ...request, approved: request.status === "approved" }),
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
