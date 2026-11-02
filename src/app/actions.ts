"use server";

import { z } from "zod";
import { formatSubmitted } from "@/lib/format";
import { cancelLeaveRequest, submitLeaveRequest } from "@/server/services/leave-requests";
import type { FormState } from "@/components/forms/form-state";
import { leaveRequestSchema, readDraftFields } from "./_lib/leave-input";
import { runFormAction } from "./_lib/server-action";

/** Dashboard form: asks for time off as the signed-in user. */
export async function requestLeaveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const fields = { ...readDraftFields(formData), note: formData.get("note") ?? undefined };
  return runFormAction("leave_request_submit", fields, leaveRequestSchema, async (ctx, actor, input) => {
    const request = await submitLeaveRequest(ctx, actor, input);
    return formatSubmitted({ ...request, approved: request.status === "approved" });
  });
}

const cancelSchema = z.object({ requestId: z.string().min(1).max(100) });

/** Cancels one of the signed-in user's own requests. */
export async function cancelLeaveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return runFormAction("leave_request_cancel", formData, cancelSchema, async (ctx, actor, { requestId }) => {
    await cancelLeaveRequest(ctx, actor, requestId);
    return "Cancelled.";
  });
}
