"use server";

import { z } from "zod";
import { personLabel } from "@/domain/person";
import { log } from "@/lib/log";
import { serviceContext } from "@/server/runtime";
import { approveFromEmail } from "@/server/services/email-approval";

/** What the page shows after the Approve button. */
export type ApproveOutcome = { status: "idle" } | { status: "done"; state: string; message: string };

const tokenSchema = z.string().min(1).max(512);

/** The calm sentence for each way an approve can end. */
const MESSAGES: Record<string, string> = {
  decided: "This request is no longer waiting, so nothing changed.",
  not_yours: "This request isn't yours to decide any more. Open OOOhm to see where it went.",
  expired: "This link has expired. Open OOOhm to decide.",
  invalid: "This link doesn't work. Open OOOhm to decide.",
};

/**
 * "Approved. Lena Park's time off is approved." Says only what is sure: a deactivated
 * requester gets no email and has no calendar feed.
 */
function approvedMessage(request: { requesterName: string; requesterEmail: string }): string {
  const who = personLabel({ name: request.requesterName, email: request.requesterEmail });
  return `Approved. ${who}'s time off is approved.`;
}

/**
 * Approves through a request email's link. No session: the signed token is the
 * credential, and the service checks it and the approver again before deciding.
 */
export async function approveFromEmailAction(_prev: ApproveOutcome, formData: FormData): Promise<ApproveOutcome> {
  const parsed = tokenSchema.safeParse(formData.get("token"));
  if (!parsed.success) return { status: "done", state: "invalid", message: MESSAGES.invalid };
  try {
    const result = await approveFromEmail(serviceContext(), parsed.data);
    if (result.state === "approved") return { status: "done", state: "approved", message: approvedMessage(result.request) };
    return { status: "done", state: result.state, message: MESSAGES[result.state] ?? MESSAGES.invalid };
  } catch (err) {
    log.error({ err }, "email_approve_failed");
    return { status: "done", state: "error", message: "Something went wrong. Open OOOhm to decide." };
  }
}
