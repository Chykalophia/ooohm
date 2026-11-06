import { type InviteEmail, INVITE_COPY, renderInviteEmail } from "./templates/invite";
import { LEAVE_KINDS, type LeaveEmail, type LeaveKind, type LeaveSummary, leaveVariables, renderLeaveEmail } from "./templates/leave";
import { notificationType, type NotificationType } from "./types";

/** A leave email's data: the email without its kind, plus the request it is about (for logs). */
export type LeaveNotificationData<K extends LeaveKind> = Omit<Extract<LeaveEmail, { kind: K }>, "kind"> & { requestId: string };

/** The request every preview shows. */
const SAMPLE_LEAVE: LeaveSummary = {
  requesterName: "Ana Ruiz",
  leaveTypeName: "PTO",
  startDate: "2026-11-02",
  endDate: "2026-11-06",
  dayPortion: "full",
  days: 5,
  note: "Visiting family",
};
const SAMPLE_LINK = "https://ooohm.example/";
/** Where every sign-in link in a preview points: a placeholder, never a real link. */
export const PREVIEW_SIGN_IN_URL = `${SAMPLE_LINK}sign-in`;

function leave<K extends LeaveKind>(
  kind: K,
  label: string,
  description: string,
  sample: Omit<LeaveNotificationData<K>, "requestId" | "leave" | "link"> & { leave?: LeaveSummary },
): NotificationType<LeaveNotificationData<K>> {
  return notificationType({
    failureEvent: "leave_email_failed",
    logFields: ({ requestId }) => ({ requestId, kind }),
    copy: {
      label,
      description,
      defaults: LEAVE_KINDS[kind].defaults,
      variables: leaveVariables(kind),
      sample: { leave: SAMPLE_LEAVE, link: SAMPLE_LINK, requestId: "preview", ...sample } as LeaveNotificationData<K>,
    },
    // The template reads only the email's own fields; `requestId` rides along unread.
    build: (data, { accent, copy }) => renderLeaveEmail({ kind, ...data } as LeaveEmail, accent, copy),
  });
}

/** The invite's data: the link is issued at send time, once the account has committed. */
export type InviteNotificationData = Omit<InviteEmail, "link"> & { userId: string };

const invite = notificationType<InviteNotificationData>({
  failureEvent: "invite_email_failed",
  logFields: ({ userId }) => ({ userId }),
  copy: {
    label: "Invite",
    description: "To someone an admin adds, with their first sign-in link.",
    ...INVITE_COPY,
    sample: { userId: "preview", recipientName: "Ana Ruiz", inviterName: "Mo Reyes", companyName: "Acme", signInUrl: PREVIEW_SIGN_IN_URL },
  },
  build: async (data, { to, accent, issueSignInLink, copy }) =>
    renderInviteEmail({ ...data, link: await issueSignInLink(to) }, accent, copy),
});

/**
 * Every email the app sends on a change, by type, in the order the email editor lists
 * them. To add one: write its template in `./templates`, add an entry here, and send it
 * from the service as a {@link Notification}. The sign-in email someone asks for on the
 * sign-in page is not here: Better Auth sends it (`src/lib/auth.ts`), outside any change.
 */
export const NOTIFICATION_TYPES = {
  "leave.requested": leave("requested", "Time off request", "To the approver, when someone asks for time off.", {
    recipientName: "Mo Reyes",
    alsoOff: "Aisha Khan is off then too.",
    approveLink: `${SAMPLE_LINK}approve/preview`,
  }),
  "leave.approved": leave("approved", "Approved", "To the person, when their time off is approved.", {
    recipientName: "Ana Ruiz",
    reason: "Enjoy it!",
  }),
  "leave.rejected": leave("rejected", "Declined", "To the person, when their request is declined.", {
    recipientName: "Ana Ruiz",
    reason: "It's launch week. Could you move it by a week?",
  }),
  "leave.added": leave("added", "Added for someone", "To the person, when a manager or admin adds time off for them.", {
    recipientName: "Ana Ruiz",
    addedByName: "Mo Reyes",
  }),
  "leave.cancelled_requester": leave("cancelled_requester", "Cancelled (to the person)", "To the person, when they cancel their time off.", {
    recipientName: "Ana Ruiz",
  }),
  "leave.cancelled_approver": leave("cancelled_approver", "Cancelled (to the approver)", "To the approver, when someone cancels time off.", {
    recipientName: "Mo Reyes",
  }),
  "leave.recounted": leave(
    "recounted",
    "Recounted",
    "To the person, when a holiday or working-day change alters what their time off takes.",
    {
      recipientName: "Ana Ruiz",
      leave: { ...SAMPLE_LEAVE, days: 4 },
      previousDays: 5,
      cause: { kind: "holidays", added: [{ date: "2026-11-03", name: "Founders' Day" }], removed: [] },
      overdrawn: null,
    },
  ),
  invite,
};

export type NotificationKind = keyof typeof NOTIFICATION_TYPES;

type DataOf<K extends NotificationKind> = (typeof NOTIFICATION_TYPES)[K] extends NotificationType<infer D> ? D : never;

/** One email to send once a change commits: its type, who it goes to, and the type's data. */
export type Notification = { [K in NotificationKind]: { type: K; to: string; data: DataOf<K> } }[NotificationKind];

export function isNotificationKind(value: string): value is NotificationKind {
  return Object.hasOwn(NOTIFICATION_TYPES, value);
}
