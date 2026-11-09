import { type InviteEmail, renderInviteEmail } from "./templates/invite";
import { type LeaveEmail, type LeaveKind, renderLeaveEmail } from "./templates/leave";
import { notificationType, type NotificationType } from "./types";

/** A leave email's data: the email without its kind, plus the request it is about (for logs). */
export type LeaveNotificationData<K extends LeaveKind> = Omit<Extract<LeaveEmail, { kind: K }>, "kind"> & { requestId: string };

function leave<K extends LeaveKind>(kind: K): NotificationType<LeaveNotificationData<K>> {
  return notificationType({
    failureEvent: "leave_email_failed",
    logFields: ({ requestId }) => ({ requestId, kind }),
    // The template reads only the email's own fields; `requestId` rides along unread.
    build: (data, { accent }) => renderLeaveEmail({ kind, ...data } as LeaveEmail, accent),
  });
}

/** The invite's data: the link is issued at send time, once the account has committed. */
export type InviteNotificationData = Omit<InviteEmail, "link"> & { userId: string };

const invite = notificationType<InviteNotificationData>({
  failureEvent: "invite_email_failed",
  logFields: ({ userId }) => ({ userId }),
  build: async (data, { to, accent, issueSignInLink }) => renderInviteEmail({ ...data, link: await issueSignInLink(to) }, accent),
});

/**
 * Every email the app sends on a change, by type. To add one: write its template in
 * `./templates`, add an entry here, and send it from the service as a {@link Notification}.
 * The sign-in email someone asks for on the sign-in page is not here: Better Auth sends
 * it (`src/lib/auth.ts`), outside any change.
 */
export const NOTIFICATION_TYPES = {
  "leave.requested": leave("requested"),
  "leave.approved": leave("approved"),
  "leave.added": leave("added"),
  "leave.rejected": leave("rejected"),
  "leave.cancelled_requester": leave("cancelled_requester"),
  "leave.cancelled_approver": leave("cancelled_approver"),
  "leave.recounted": leave("recounted"),
  invite,
};

export type NotificationKind = keyof typeof NOTIFICATION_TYPES;

type DataOf<K extends NotificationKind> = (typeof NOTIFICATION_TYPES)[K] extends NotificationType<infer D> ? D : never;

/** One email to send once a change commits: its type, who it goes to, and the type's data. */
export type Notification = { [K in NotificationKind]: { type: K; to: string; data: DataOf<K> } }[NotificationKind];
