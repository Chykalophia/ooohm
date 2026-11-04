"use server";

import { z } from "zod";
import { NOTE_MAX_LENGTH } from "@/domain/leave-request";
import { decideLeaveRequest } from "@/server/services/approvals";
import type { FormState } from "@/components/forms/form-state";
import { formFields } from "@/app/_lib/form-fields";
import { runFormAction } from "@/app/_lib/server-action";
import { DECIDED_MESSAGE } from "./decision-outcome";

const decideSchema = z.object({
  requestId: formFields.id,
  decision: z.enum(["approve", "reject"]),
  reason: z.string().max(NOTE_MAX_LENGTH).optional(),
});

/** Approvals inbox: approves or declines one pending request. */
export async function decideLeaveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return runFormAction(
    "leave_request_decide",
    formData,
    decideSchema,
    async (ctx, actor, input) => {
      const request = await decideLeaveRequest(ctx, actor, input);
      return request.status === "approved" ? DECIDED_MESSAGE.approve : DECIDED_MESSAGE.reject;
    },
    // No refresh here: the decided card shows its outcome for a moment first, then
    // refreshes the page itself (ApprovalItem), so it never vanishes mid-click.
    { refresh: false },
  );
}
