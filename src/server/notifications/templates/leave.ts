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
  heading,
  MUTED,
  paragraph,
} from "@/lib/email-layout";
import type { EmailContent } from "./content";

/**
 * Leave notification emails: calm plain text plus an HTML twin in the shared layout
 * (`@/lib/email-layout`), with the company's accent. Each kind supplies only its words
 * ({@link LEAVE_COPY}); the layout, links and escaping are shared ({@link renderLeaveEmail}).
 */

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
  | {
      kind: "added";
      recipientName: string;
      leave: LeaveSummary;
      /** The manager or admin who added the time off for the recipient. */
      addedByName: string;
      link: string;
    }
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

/** One leave email's kind, and the email of that kind. */
export type LeaveKind = LeaveEmail["kind"];
type LeaveEmailOf<K extends LeaveKind> = Extract<LeaveEmail, { kind: K }>;

/** The request as one phrase, and the requester's name (or "Someone", the last resort). */
interface Phrases {
  type: Segment;
  when: string;
  requester: string;
}

/**
 * What each kind says, given its email and the request's phrases. Adding a kind is one
 * entry here and one in the {@link LeaveEmail} union; the layout never changes.
 */
const LEAVE_COPY: { [K in LeaveKind]: (email: LeaveEmailOf<K>, p: Phrases) => Parts } = {
  requested: (email, { type, when, requester }) => ({
    // The name is one capped line (`displayName`), so it cannot add a header.
    subject: `${requester} asked for ${formatDateSpan(email.leave.startDate, email.leave.endDate)}`,
    lead: [{ text: `${requester} asked for ` }, type, { text: `, ${when}.` }],
    quote: email.leave.note ?? undefined,
    overlap: email.alsoOff ?? undefined,
  }),
  approved: (email, { type, when }) => ({
    subject: "Your time off is approved",
    lead: [{ text: "Your " }, type, { text: ` is approved, ${when}.` }],
    extra: email.reason ? { label: "Note from approver", value: email.reason, quoted: true } : undefined,
  }),
  added: (email, { type, when }) => ({
    subject: "Time off was added for you",
    lead: [{ text: `${email.addedByName || "Someone"} added your ` }, type, { text: `, ${when}. It's approved, so there's nothing you need to do.` }],
    extra: email.leave.note ? { label: "Note", value: email.leave.note, quoted: true } : undefined,
  }),
  rejected: (email, { type, when }) => ({
    subject: "Your time off request was declined",
    lead: [{ text: "Your " }, type, { text: ` request was declined, ${when}.` }],
    extra: email.reason ? { label: "Reason", value: email.reason, quoted: true } : undefined,
  }),
  cancelled_requester: (_email, { type, when }) => ({
    subject: "Your time off request was cancelled",
    lead: [{ text: "Your " }, type, { text: ` request was cancelled, ${when}.` }],
  }),
  cancelled_approver: (_email, { type, when, requester }) => ({
    subject: "A time off request was cancelled",
    lead: [{ text: `${requester} cancelled their ` }, type, { text: `, ${when}. Nothing else is needed from you.` }],
  }),
  recounted: (email, { type }) => {
    const { leave } = email;
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
  },
};

function parts(email: LeaveEmail): Parts {
  const { type, when } = what(email.leave);
  // Callers pass `personLabel`, which falls back to the email address; this is the last resort.
  const requester = email.leave.requesterName || "Someone";
  const copy = LEAVE_COPY[email.kind] as (email: LeaveEmail, p: Phrases) => Parts;
  return copy(email, { type, when, requester });
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
    ...(input.kind === "added" ? { addedByName: displayName(input.addedByName) } : {}),
  } as LeaveEmail;
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

  const approveNote = approveLink
    ? "The Approve link is for you alone and stops working once the request is decided. To decline, open the request in OOOhm."
    : null;
  const text = [
    p.lead.map((s) => s.text).join(""),
    ...(p.quote ? ["", quoted(p.quote)] : []),
    ...(p.overlap ? ["", p.overlap] : []),
    ...(extra ? ["", extra] : []),
    "",
    ...(approveLink
      ? [`Approve: ${approveLink}`, `Decline or look closer in OOOhm: ${link}`]
      : [`${actions[0].label}: ${link}`]),
    ...(approveNote ? ["", approveNote] : []),
    "",
  ].join("\n");

  const lead = p.lead.map((s) => (s.bold ? `<b style="font-weight:600">${escapeHtml(s.text)}</b>` : escapeHtml(s.text))).join("");
  const body =
    heading(lead) +
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

  return { subject: p.subject, text, html: emailDocument(body, accent, approveNote ? escapeHtml(approveNote) : undefined, p.subject) };
}
