import { displayName } from "@/domain/person";
import { formatDateSpan, formatDays, formatLeaveDates, formatRecountCause } from "@/lib/format";
import type { RecountCause } from "@/lib/format";
import {
  BODY,
  buttons,
  DEFAULT_EMAIL_ACCENT,
  dot,
  type EmailAccent,
  type EmailButton,
  emailDocument,
  escapeHtml,
  MUTED,
  paragraph,
} from "@/lib/email-layout";

export { displayName, personLabel } from "@/domain/person";
export { DEFAULT_EMAIL_ACCENT, type EmailAccent, emailAccent, escapeHtml } from "@/lib/email-layout";

/**
 * Leave notification emails: calm plain text plus an HTML twin in the shared layout
 * (`./layout`), with the company's accent.
 */

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

/** The request as it appears in an email. */
export interface LeaveSummary {
  requesterName: string;
  leaveTypeName: string;
  startDate: string;
  endDate: string;
  dayPortion: "full" | "am" | "pm";
  days: number;
  note: string | null;
}

export type LeaveEmail =
  | {
      kind: "requested";
      recipientName: string;
      leave: LeaveSummary;
      /** Who else is off on those dates, as the approver reads it on Approvals (`alsoOffFor`). */
      alsoOff?: string | null;
      link: string;
      /** The one-click approve page for this approver, when the sender can sign one. */
      approveLink?: string | null;
    }
  | { kind: "approved"; recipientName: string; leave: LeaveSummary; reason: string | null; link: string }
  | { kind: "rejected"; recipientName: string; leave: LeaveSummary; reason: string | null; link: string }
  | { kind: "cancelled_requester"; recipientName: string; leave: LeaveSummary; link: string }
  | { kind: "cancelled_approver"; recipientName: string; leave: LeaveSummary; link: string }
  | {
      kind: "recounted";
      recipientName: string;
      /** The request after the recount: `days` is the new count. */
      leave: LeaveSummary;
      previousDays: number;
      cause: RecountCause;
      /** Set when the new count leaves the person over their balance, e.g. "1 day over your PTO balance for 2026". */
      overdrawn: string | null;
      link: string;
    };

interface Segment {
  text: string;
  bold?: boolean;
}

interface Parts {
  subject: string;
  /** The opening sentence, which says what happened and to which request. */
  lead: Segment[];
  /** The requester's note, shown in quotes (request emails only). */
  quote?: string;
  /** A labelled line after the lead, e.g. a decline reason; `quoted` for words someone typed. */
  extra?: { label: string; value: string; quoted: boolean };
  /** Who else is off then, after a small accent mark. */
  overlap?: string;
}

const quoted = (value: string) => `\u201c${value}\u201d`;

/** "PTO" (bold) and its dates and days: the request as one phrase. */
function what(leave: LeaveSummary): { type: Segment; when: string } {
  return {
    type: { text: leave.leaveTypeName, bold: true },
    when: `${formatLeaveDates(leave.startDate, leave.endDate, leave.dayPortion)}: ${formatDays(leave.days)}`,
  };
}

function parts(email: LeaveEmail): Parts {
  const { leave } = email;
  const { type, when } = what(leave);
  switch (email.kind) {
    case "requested":
      return {
        // The name is one capped line (`displayName`), so it cannot add a header.
        subject: `${leave.requesterName || "Someone"} asked for ${formatDateSpan(leave.startDate, leave.endDate)}`,
        lead: [{ text: `${leave.requesterName} asked for ` }, type, { text: `, ${when}.` }],
        quote: leave.note ?? undefined,
        overlap: email.alsoOff ?? undefined,
      };
    case "approved":
      return {
        subject: "Your time off is approved",
        lead: [{ text: "Your " }, type, { text: ` is approved: ${when}.` }],
        extra: email.reason ? { label: "Note from approver", value: email.reason, quoted: true } : undefined,
      };
    case "rejected":
      return {
        subject: "Your time off request was declined",
        lead: [{ text: "Your " }, type, { text: ` request was declined: ${when}.` }],
        extra: email.reason ? { label: "Reason", value: email.reason, quoted: true } : undefined,
      };
    case "cancelled_requester":
      return {
        subject: "Your time off request was cancelled",
        lead: [{ text: "Your " }, type, { text: ` request was cancelled: ${when}.` }],
      };
    case "cancelled_approver":
      return {
        subject: "A time off request was cancelled",
        lead: [{ text: `${leave.requesterName} cancelled their ` }, type, { text: `: ${when}. Nothing else is needed from you.` }],
      };
    case "recounted": {
      const cause = formatRecountCause(email.cause);
      const dates = formatLeaveDates(leave.startDate, leave.endDate, leave.dayPortion);
      if (leave.days === 0) {
        return {
          subject: "Your time off was recounted",
          lead: [
            { text: `${cause}, so your ` },
            type,
            {
              text: ` for ${dates} no longer takes any days, and nothing comes off your balance. You can cancel it in OOOhm if you don't need it.`,
            },
          ],
        };
      }
      // Same total, days moved between years (a working-days change across New Year): only
      // sent when that leaves a year over its balance.
      const change =
        leave.days === email.previousDays
          ? `still takes ${formatDays(leave.days)}, but some of it now counts in a different year`
          : `now takes ${formatDays(leave.days)} instead of ${formatDays(email.previousDays)}`;
      return {
        subject: "Your time off was recounted",
        lead: [{ text: `${cause}, so your ` }, type, { text: ` for ${dates} ${change}.` }],
        extra: email.overdrawn ? { label: "Balance", value: `This leaves you ${email.overdrawn}.`, quoted: false } : undefined,
      };
    }
  }
}

/**
 * Subject, text and HTML for one leave notification, laid out like the request email on
 * the OOOhm site: one sentence that says it all, the requester's note in quotes, who else
 * is off, then the buttons. `accent` is the company's ({@link emailAccent}).
 *
 * Subjects are fixed per kind, except the request email's, which names the requester
 * and the dates as the inbox should show them. Names there are one capped line
 * (`displayName`), so no typed value can add a header; notes and reasons appear in the
 * body only, HTML-escaped there.
 */
export function renderLeaveEmail(input: LeaveEmail, accent: EmailAccent = DEFAULT_EMAIL_ACCENT): EmailContent {
  const email: LeaveEmail = {
    ...input,
    recipientName: displayName(input.recipientName),
    leave: { ...input.leave, requesterName: displayName(input.leave.requesterName) },
  };
  const { link } = email;
  const p = parts(email);
  const approveLink = email.kind === "requested" ? (email.approveLink ?? null) : null;
  const extra = p.extra && `${p.extra.label}: ${p.extra.quoted ? quoted(p.extra.value) : p.extra.value}`;

  const actions: EmailButton[] = approveLink
    ? [
        { label: "Approve", href: approveLink, variant: "primary" },
        { label: "Open in OOOhm", href: link, variant: "quiet" },
      ]
    : [{ label: email.kind === "requested" ? "Review in OOOhm" : "Open in OOOhm", href: link, variant: "primary" }];

  const text = [
    p.lead.map((s) => s.text).join(""),
    ...(p.quote ? ["", quoted(p.quote)] : []),
    ...(p.overlap ? ["", p.overlap] : []),
    ...(extra ? ["", extra] : []),
    "",
    ...(approveLink
      ? [`Approve: ${approveLink}`, `Decline or look closer in OOOhm: ${link}`]
      : [`${actions[0].label}: ${link}`]),
    "",
  ].join("\n");

  const lead = p.lead.map((s) => (s.bold ? `<b style="font-weight:600">${escapeHtml(s.text)}</b>` : escapeHtml(s.text))).join("");
  const body =
    paragraph(lead) +
    (p.quote ? paragraph(escapeHtml(quoted(p.quote)), `color:${BODY};white-space:pre-wrap`) : "") +
    (p.overlap ? paragraph(dot(accent) + escapeHtml(p.overlap), `color:${BODY};font-size:15px`) : "") +
    (p.extra
      ? paragraph(
          `<span style="color:${MUTED}">${escapeHtml(p.extra.label)}:</span> ` +
            escapeHtml(p.extra.quoted ? quoted(p.extra.value) : p.extra.value),
          `color:${BODY};white-space:pre-wrap`,
        )
      : "") +
    buttons(actions, accent);
  const footer = approveLink
    ? `The Approve link is for you alone and stops working once the request is decided. Declining needs a reason, so it happens in OOOhm.`
    : undefined;

  return { subject: p.subject, text, html: emailDocument(body, accent, footer) };
}
