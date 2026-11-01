"use server";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NOTE_MAX_LENGTH } from "@/domain/leave-request";
import { requireActor } from "@/lib/auth";
import { serviceContext } from "@/server/runtime";
import { decideLeaveRequest } from "@/server/services/approvals";
import type { FormState } from "@/app/form-state";
import { messageFor, runAction } from "@/app/run-action";

const decideSchema = z.object({
  requestId: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
  reason: z.string().max(NOTE_MAX_LENGTH).optional(),
});

/** Approvals inbox: approves or declines one pending request. */
export async function decideLeaveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { actor } = await requireActor();
  if (!actor) return { status: "error", message: messageFor("no_company") };

  const parsed = decideSchema.safeParse({
    requestId: formData.get("requestId") ?? "",
    decision: formData.get("decision") ?? "",
    reason: formData.get("reason") ?? undefined,
  });
  if (!parsed.success) return { status: "error", message: messageFor("invalid_input") };

  // No refresh: the decided item stays on screen showing its outcome until the
  // next visit, rather than vanishing mid-click.
  return runAction("leave_request_decide", async () => {
    const request = await decideLeaveRequest(serviceContext(), actor, parsed.data);
    return {
      id: randomUUID(),
      message: request.status === "approved" ? "Approved." : "Declined.",
    };
  });
}
