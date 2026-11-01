import type { Transaction } from "@/db/types";
import { log } from "@/lib/log";
import { type LeaveEmail, renderLeaveEmail } from "@/server/email/leave-emails";
import type { ServiceContext } from "@/server/context";

/** A rendered email and the address it goes to. */
export interface Outgoing {
  to: string;
  email: LeaveEmail;
}

/**
 * Queues emails to send once the caller's transaction has committed.
 *
 * Call it only after `db.transaction(...)` resolves, so a rolled-back change never
 * emails anyone. Each send is isolated: a failure is logged (with the request id and
 * email kind, never the address) and the remaining emails still go out. Nothing here
 * throws to the caller, so a mail outage never fails a leave request.
 */
function notifyAfterCommit(ctx: ServiceContext, requestId: string, outgoing: readonly Outgoing[]): void {
  if (outgoing.length === 0) return;
  ctx.defer(async () => {
    for (const { to, email } of outgoing) {
      try {
        await ctx.mailer({ to, ...renderLeaveEmail(email) });
      } catch (err) {
        log.error({ err, requestId, kind: email.kind }, "leave_email_failed");
      }
    }
  });
}

/**
 * Runs `work` in a transaction, then queues the emails it returned. The only way the
 * leave services send mail: ordering is fixed here, so no service can email about a
 * change that later rolls back.
 */
export async function commitThenNotify<T extends { id: string }>(
  ctx: ServiceContext,
  work: (tx: Transaction) => Promise<{ result: T; outgoing: readonly Outgoing[] }>,
): Promise<T> {
  const { result, outgoing } = await ctx.db.transaction(work);
  notifyAfterCommit(ctx, result.id, outgoing);
  return result;
}
