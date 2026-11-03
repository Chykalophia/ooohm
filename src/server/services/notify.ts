import type { Transaction } from "@/db/types";
import { log } from "@/lib/log";
import { type EmailContent, type LeaveEmail, renderLeaveEmail } from "@/server/email/leave-emails";
import type { ServiceContext } from "@/server/context";
import { wroteOutboxEvents } from "@/server/repositories/change-log";
import { emailAccentFor } from "./email-accent";

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
 * Runs `work` in a transaction and, once it has committed, wakes the background work
 * (`ctx.wake`, through `defer`) if the transaction wrote outbox events. The one
 * transaction entry point for services that record changes, so in `inline` mode every
 * change's webhooks go out right after the response, with no worker. A rolled-back
 * transaction wakes nothing.
 */
export async function inTransaction<T>(ctx: ServiceContext, work: (tx: Transaction) => Promise<T>): Promise<T> {
  const { result, wrote } = await transact(ctx, work);
  if (wrote) wakeAfterCommit(ctx);
  return result;
}

async function transact<T>(ctx: ServiceContext, work: (tx: Transaction) => Promise<T>): Promise<{ result: T; wrote: boolean }> {
  let wrote = false;
  const result = await ctx.db.transaction(async (tx) => {
    const value = await work(tx);
    wrote = wroteOutboxEvents(tx);
    return value;
  });
  return { result, wrote };
}

function wakeAfterCommit(ctx: ServiceContext): void {
  const wake = ctx.wake;
  if (wake) ctx.defer(wake);
}

/**
 * Runs `work` in a transaction ({@link inTransaction}), then queues the emails it
 * returned. The only way services send mail: ordering is fixed here, so no service can
 * email about a change that later rolls back.
 */
export async function commitThenSend<T>(
  ctx: ServiceContext,
  work: (tx: Transaction) => Promise<{ result: T; outgoing: readonly DeferredEmail[] }>,
): Promise<T> {
  const {
    result: { result, outgoing },
    wrote,
  } = await transact(ctx, work);
  // Emails first: a sign-in or decision email should not wait behind a webhook timeout.
  sendAfterCommit(ctx, outgoing);
  if (wrote) wakeAfterCommit(ctx);
  return result;
}

/**
 * {@link commitThenSend} for the leave services: emails carry the request's company
 * accent, and a failed send is logged as `leave_email_failed` with the request id and
 * email kind.
 */
export async function commitThenNotify<T extends { id: string; companyId: string }>(
  ctx: ServiceContext,
  work: (tx: Transaction) => Promise<{ result: T; outgoing: readonly Outgoing[] }>,
): Promise<T> {
  return commitThenSend(ctx, async (tx) => {
    const { result, outgoing } = await work(tx);
    const accent = emailAccentFor(ctx, result.companyId);
    return {
      result,
      outgoing: outgoing.map(({ to, email }) => ({
        to,
        build: async () => renderLeaveEmail(email, await accent()),
        failureEvent: "leave_email_failed",
        logFields: { requestId: result.id, kind: email.kind },
      })),
    };
  });
}
