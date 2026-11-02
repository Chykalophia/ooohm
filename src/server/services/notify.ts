import type { Transaction } from "@/db/types";
import { log } from "@/lib/log";
import { type EmailContent, type LeaveEmail, renderLeaveEmail } from "@/server/email/leave-emails";
import type { ServiceContext } from "@/server/context";

/** A rendered leave email and the address it goes to. */
export interface Outgoing {
  to: string;
  email: LeaveEmail;
}

/** One email to send once the transaction has committed. */
export interface DeferredEmail {
  to: string;
  /**
   * Builds the message at send time. May do I/O, such as issuing a sign-in link, which
   * must not happen before the change it belongs to has committed.
   */
  build: () => EmailContent | Promise<EmailContent>;
  /** Logged with a failure, as `failureEvent`. Never the address. */
  failureEvent: string;
  logFields: Record<string, unknown>;
}

/**
 * Queues emails to send once the caller's transaction has committed.
 *
 * Call it only after `db.transaction(...)` resolves, so a rolled-back change never
 * emails anyone. Each send is isolated: a failure is logged (with the caller's log
 * fields, never the address) and the remaining emails still go out. Nothing here
 * throws to the caller, so a mail outage never fails the change.
 */
function sendAfterCommit(ctx: ServiceContext, outgoing: readonly DeferredEmail[]): void {
  if (outgoing.length === 0) return;
  ctx.defer(async () => {
    for (const { to, build, failureEvent, logFields } of outgoing) {
      try {
        await ctx.mailer({ to, ...(await build()) });
      } catch (err) {
        log.error({ ...logFields, err }, failureEvent);
      }
    }
  });
}

/**
 * Runs `work` in a transaction, then queues the emails it returned. The only way
 * services send mail: ordering is fixed here, so no service can email about a change
 * that later rolls back.
 */
export async function commitThenSend<T>(
  ctx: ServiceContext,
  work: (tx: Transaction) => Promise<{ result: T; outgoing: readonly DeferredEmail[] }>,
): Promise<T> {
  const { result, outgoing } = await ctx.db.transaction(work);
  sendAfterCommit(ctx, outgoing);
  return result;
}

/**
 * {@link commitThenSend} for the leave services: a failed send is logged as
 * `leave_email_failed` with the request id and email kind.
 */
export async function commitThenNotify<T extends { id: string }>(
  ctx: ServiceContext,
  work: (tx: Transaction) => Promise<{ result: T; outgoing: readonly Outgoing[] }>,
): Promise<T> {
  return commitThenSend(ctx, async (tx) => {
    const { result, outgoing } = await work(tx);
    return {
      result,
      outgoing: outgoing.map(({ to, email }) => ({
        to,
        build: () => renderLeaveEmail(email),
        failureEvent: "leave_email_failed",
        logFields: { requestId: result.id, kind: email.kind },
      })),
    };
  });
}
