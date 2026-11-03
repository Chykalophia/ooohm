"use server";

import { z } from "zod";
import { log } from "@/lib/log";
import { serviceContext } from "@/server/runtime";
import { approveFromEmail } from "@/server/services/email-approval";

/** What the page shows after the Approve button. */
export type ApproveOutcome = { status: "idle" } | { status: "done"; state: string; message: string };

const tokenSchema = z.string().min(1).max(512);

/** The calm sentence for each way an approve can end. */
const MESSAGES: Record<string, string> = {
  approved: "Approved. They'll get an email saying so.",
  decided: "This request was already decided, so nothing changed.",
  not_yours: "This request isn't yours to decide any more. Open OOOhm to see where it went.",
  expired: "This link has expired. Open OOOhm to decide.",
  invalid: "This link doesn't work. Open OOOhm to decide.",
};

/**
 * Approves through a request email's link. No session: the signed token is the
 * credential, and the service checks it and the approver again before deciding.
 */
export async function approveFromEmailAction(_prev: ApproveOutcome, formData: FormData): Promise<ApproveOutcome> {
  const parsed = tokenSchema.safeParse(formData.get("token"));
  if (!parsed.success) return { status: "done", state: "invalid", message: MESSAGES.invalid };
  try {
    const result = await approveFromEmail(serviceContext(), parsed.data);
    return { status: "done", state: result.state, message: MESSAGES[result.state] ?? MESSAGES.invalid };
  } catch (err) {
    log.error({ err }, "email_approve_failed");
    return { status: "done", state: "error", message: "Something went wrong. Open OOOhm to decide." };
  }
}
