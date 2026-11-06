"use server";

import { z } from "zod";
import { formatAddedFor, formatSubmitted } from "@/lib/format";
import { addLeaveFor, removeLeaveFor } from "@/server/services/leave-on-behalf";
import { cancelLeaveRequest, submitLeaveRequest } from "@/server/services/leave-requests";
import type { FormState } from "@/components/forms/form-state";
import { leaveRequestSchema, readDraftFields } from "./_lib/leave-input";
import { formFields } from "./_lib/form-fields";
import { addForMessages } from "./_lib/leave-for-messages";
import { runFormAction } from "./_lib/server-action";

/** Dashboard form: asks for time off as the signed-in user. */
export async function requestLeaveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const fields = { ...readDraftFields(formData), note: formData.get("note") ?? undefined };
  return runFormAction("leave_request_submit", fields, leaveRequestSchema, async (ctx, actor, input) => {
    const request = await submitLeaveRequest(ctx, actor, input);
    return formatSubmitted({ ...request, approved: request.status === "approved" });
  });
}

const cancelSchema = z.object({ requestId: formFields.id });

/** Cancels one of the signed-in user's own requests. */
export async function cancelLeaveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return runFormAction("leave_request_cancel", formData, cancelSchema, async (ctx, actor, { requestId }) => {
    await cancelLeaveRequest(ctx, actor, requestId);
    return "Cancelled.";
  });
}

const addForSchema = leaveRequestSchema.extend({ userId: formFields.id });

/** A teammate's page: a manager or admin adds time off for them, approved as it is added. */
export async function addLeaveForAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const fields = { ...readDraftFields(formData), note: formData.get("note") ?? undefined, userId: formData.get("userId") ?? "" };
  return runFormAction(
    "leave_add_for",
    fields,
    addForSchema,
    async (ctx, actor, { userId, ...input }) => {
      const request = await addLeaveFor(ctx, actor, userId, input);
      return formatAddedFor(request.personName, request);
    },
    { messages: addForMessages },
  );
}

const removeForSchema = z.object({ requestId: formFields.id, reason: z.string() });

/** A teammate's page: a manager or admin removes their approved time off to correct the record, with a reason. */
export async function removeLeaveForAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const fields = { requestId: formData.get("requestId") ?? "", reason: formData.get("reason") ?? "" };
  return runFormAction("leave_remove_for", fields, removeForSchema, async (ctx, actor, { requestId, reason }) => {
    await removeLeaveFor(ctx, actor, requestId, reason);
    return "Removed. They've been emailed, and the days are back in their balance.";
  });
}
