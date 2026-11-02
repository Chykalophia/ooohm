"use server";

import { z } from "zod";
import { NOTE_MAX_LENGTH } from "@/domain/leave-request";
import { decideLeaveRequest } from "@/server/services/approvals";
import type { FormState } from "@/components/forms/form-state";
import { runFormAction } from "@/app/_lib/server-action";

const decideSchema = z.object({
  requestId: z.string().min(1).max(100),
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
      return request.status === "approved" ? "Approved." : "Declined.";
    },
    // No refresh: the decided item stays on screen showing its outcome until the
    // next visit, rather than vanishing mid-click.
    { refresh: false },
  );
}
