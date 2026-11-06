import { log } from "@/lib/log";
import type { ServiceContext } from "@/server/context";
import { emailAccentFor } from "./accent";
import { NOTIFICATION_TYPES, type Notification } from "./catalog";
import type { NotificationType } from "./types";

/**
 * Queues `notifications` (all from one change in `companyId`) to send through
 * `ctx.mailer`, through `defer`. Call it only once the change has committed
 * (`commitThenNotify` does), so a rolled-back change never emails anyone.
 *
 * Every email takes the company's accent, read once for all of them. Each one is built
 * and sent on its own: a failure is logged as its type's `failureEvent` with its log
 * fields (never the address), and the rest still go out. Nothing here throws to the
 * caller, so a mail outage never fails the change.
 */
export function sendAfterCommit(ctx: ServiceContext, companyId: string, notifications: readonly Notification[]): void {
  if (notifications.length === 0) return;
  const accentOf = emailAccentFor(ctx, companyId);
  ctx.defer(async () => {
    for (const notification of notifications) {
      const type = NOTIFICATION_TYPES[notification.type] as NotificationType<unknown>;
      try {
        const env = { to: notification.to, accent: await accentOf(), issueSignInLink: ctx.issueSignInLink };
        await ctx.mailer({ to: notification.to, ...(await type.build(notification.data, env)) });
      } catch (err) {
        log.error({ ...type.logFields(notification.data), err }, type.failureEvent);
      }
    }
  });
}
