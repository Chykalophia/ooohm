import type { EmailCopy } from "@/domain/email-template";
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
import { type CopyTemplate, type CopyVariable, fillMessage, fillSubject, resolveCopy } from "./copy";

/**
 * Leave notification emails: calm plain text plus an HTML twin in the shared layout
 * (`@/lib/email-layout`), with the company's accent. Each kind supplies only its words, as
 * a default subject and message an admin can replace ({@link LEAVE_KINDS}); the layout,
 * the request's details, the links and the escaping are shared ({@link renderLeaveEmail}).
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
  /** Heads-up time off (approval turned off): the requester's confirmation. */
  | { kind: "booked"; recipientName: string; leave: LeaveSummary; link: string }
  /** Heads-up time off: the manager (or fallback admin) is told, not asked. */
  | {
      kind: "heads_up";
      recipientName: string;
      leave: LeaveSummary;
      /** Who else is off on those dates (`alsoOffFor`). */
      alsoOff?: string | null;
      link: string;
    }
  | {
      kind: "added";
      recipientName: string;
      leave: LeaveSummary;
      /** The manager or admin who added the time off for the recipient. */
      addedByName: string;
      link: string;
    }
  | {
      kind: "removed";
      recipientName: string;
      leave: LeaveSummary;
      /** The manager or admin who removed the recipient's time off, to correct the record. */
      removedByName: string;
      /** Why, as they gave it (required). */
      reason: string;
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

/** One leave email's kind, and the email of that kind. */
export type LeaveKind = LeaveEmail["kind"];
type LeaveEmailOf<K extends LeaveKind> = Extract<LeaveEmail, { kind: K }>;

/** What follows the message: details the email adds on its own, which copy cannot change. */
interface Details {
  /** The requester's note, shown in quotes. */
  quote?: string;
  /** A labelled line, e.g. a decline reason; `quoted` for words someone typed. */
  extra?: { label: string; value: string; quoted: boolean };
  /** Who else is off then, after a small accent mark. */
  overlap?: string;
}

/** One kind: its default words, the variables beyond the common ones, and its details. */
interface LeaveKindSpec<K extends LeaveKind> {
  defaults: CopyTemplate;
  variables?: readonly CopyVariable[];
  values?: (email: LeaveEmailOf<K>) => Record<string, string>;
  details?: (email: LeaveEmailOf<K>) => Details;
}

/** Variables every leave email has. `leave_type` is bold in HTML. */
export const LEAVE_VARIABLES: readonly CopyVariable[] = [
  { name: "recipient", description: "The name of the person this email goes to" },
  { name: "requester", description: "The name of the person the time off is for" },
  { name: "leave_type", description: "The leave type, such as PTO (shown in bold)" },
  { name: "dates", description: "The dates in full, such as Mon, Nov 2 to Fri, Nov 6, 2026" },
  { name: "date_span", description: "The dates in short, such as Nov 2 to Nov 6" },
  { name: "days", description: "How many working days it takes, such as 5 days" },
];

const quoted = (value: string) => `\u201c${value}\u201d`;

/**
 * Every leave kind. Adding one is an entry here and one in the {@link LeaveEmail} union;
 * the layout never changes. The defaults are the emails as OOOhm has always sent them.
 */
export const LEAVE_KINDS: { [K in LeaveKind]: LeaveKindSpec<K> } = {
  requested: {
    defaults: { subject: "{{requester}} asked for {{date_span}}", message: "{{requester}} asked for {{leave_type}}, {{dates}}: {{days}}." },
    details: (email) => ({ quote: email.leave.note ?? undefined, overlap: email.alsoOff ?? undefined }),
  },
  approved: {
    defaults: { subject: "Your time off is approved", message: "Your {{leave_type}} is approved, {{dates}}: {{days}}." },
    details: (email) => ({ extra: email.reason ? { label: "Note from approver", value: email.reason, quoted: true } : undefined }),
  },
  booked: {
    defaults: { subject: "Your time off is booked", message: "Your {{leave_type}} is booked, {{dates}}: {{days}}. Enjoy it." },
  },
  heads_up: {
    defaults: {
      subject: "{{requester}} is off {{date_span}}",
      message: "{{requester}} is taking {{leave_type}}, {{dates}}: {{days}}. It's booked, so there's nothing you need to do.",
    },
    details: (email) => ({ quote: email.leave.note ?? undefined, overlap: email.alsoOff ?? undefined }),
  },
  added: {
    defaults: {
      subject: "Time off was added for you",
      message: "{{added_by}} added your {{leave_type}}, {{dates}}: {{days}}. It's approved, so there's nothing you need to do.",
    },
    variables: [{ name: "added_by", description: "The name of the manager or admin who added it" }],
    values: (email) => ({ added_by: email.addedByName || "Someone" }),
    details: (email) => ({ extra: email.leave.note ? { label: "Note", value: email.leave.note, quoted: true } : undefined }),
  },
  removed: {
    defaults: {
      subject: "Time off was removed for you",
      message: "{{removed_by}} removed your {{leave_type}}, {{dates}}: {{days}}. Those days are back in your balance.",
    },
    variables: [{ name: "removed_by", description: "The name of the manager or admin who removed it" }],
    values: (email) => ({ removed_by: email.removedByName || "Someone" }),
    details: (email) => ({ extra: { label: "Reason", value: email.reason, quoted: true } }),
  },
  rejected: {
    defaults: { subject: "Your time off request was declined", message: "Your {{leave_type}} request was declined, {{dates}}: {{days}}." },
    details: (email) => ({ extra: email.reason ? { label: "Reason", value: email.reason, quoted: true } : undefined }),
  },
  cancelled_requester: {
    defaults: { subject: "Your time off request was cancelled", message: "Your {{leave_type}} request was cancelled, {{dates}}: {{days}}." },
  },
  cancelled_approver: {
    defaults: {
      subject: "A time off request was cancelled",
      message: "{{requester}} cancelled their {{leave_type}}, {{dates}}: {{days}}. Nothing else is needed from you.",
    },
  },
  recounted: {
    defaults: { subject: "Your time off was recounted", message: "{{cause}}, so your {{leave_type}} for {{dates}} {{change}}." },
    variables: [
      { name: "cause", description: "What changed, such as Tue, Nov 3, 2026 is now a company holiday (Founders' Day)" },
      { name: "change", description: "What that does to the time off, such as now takes 4 days instead of 5 days" },
      { name: "previous_days", description: "How many working days it took before, such as 5 days" },
    ],
    values: (email) => {
      const { days } = email.leave;
      // Same total, days moved between years (a working-days change across New Year): only
      // sent when that leaves a year over its balance.
      const change =
        days === 0
          ? "no longer takes any days, and nothing comes off your balance. You can cancel it in OOOhm if you don't need it"
          : days === email.previousDays
            ? `still takes ${formatDays(days)}, but some of it now counts in a different year`
            : `now takes ${formatDays(days)} instead of ${formatDays(email.previousDays)}`;
      return { cause: formatRecountCause(email.cause), change, previous_days: formatDays(email.previousDays) };
    },
    details: (email) => ({
      extra:
        email.leave.days !== 0 && email.overdrawn ? { label: "Balance", value: `This leaves you ${email.overdrawn}.`, quoted: false } : undefined,
    }),
  },
};

/** The variables a kind's copy may use: the common ones, then its own. */
export function leaveVariables(kind: LeaveKind): readonly CopyVariable[] {
  return [...LEAVE_VARIABLES, ...(LEAVE_KINDS[kind].variables ?? [])];
}

function valuesFor(email: LeaveEmail): Record<string, string> {
  const { leave } = email;
  const spec = LEAVE_KINDS[email.kind] as LeaveKindSpec<LeaveKind>;
  return {
    recipient: email.recipientName,
    // Callers pass `personLabel`, which falls back to the email address; this is the last resort.
    requester: leave.requesterName || "Someone",
    leave_type: leave.leaveTypeName,
    dates: formatLeaveDates(leave.startDate, leave.endDate, leave.dayPortion),
    date_span: formatDateSpan(leave.startDate, leave.endDate),
    days: formatDays(leave.days),
    ...spec.values?.(email),
  };
}

/**
 * Subject, text and HTML for one leave notification, laid out like the request email on
 * the OOOhm site: the message (its first paragraph says it all), the requester's note in
 * quotes, who else is off, any further paragraphs of the message, then the buttons.
 * `accent` is the company's ({@link emailAccent}); `saved` is the company's own words for
 * this kind, if any (else the defaults in {@link LEAVE_KINDS}).
 *
 * Names are one capped line (`displayName`) and the subject is filled onto one line, so
 * no typed value can add a header; notes and reasons appear in the body only,
 * HTML-escaped there, and are not variables.
 */
export function renderLeaveEmail(input: LeaveEmail, accent: EmailAccent = DEFAULT_EMAIL_ACCENT, saved?: EmailCopy | null): EmailContent {
  const email: LeaveEmail = {
    ...input,
    recipientName: displayName(input.recipientName),
    leave: { ...input.leave, requesterName: displayName(input.leave.requesterName) },
    ...(input.kind === "added" ? { addedByName: displayName(input.addedByName) } : {}),
    ...(input.kind === "removed" ? { removedByName: displayName(input.removedByName) } : {}),
  } as LeaveEmail;
  const { link } = email;
  const spec = LEAVE_KINDS[email.kind] as LeaveKindSpec<LeaveKind>;
  const copy = resolveCopy(spec.defaults, saved);
  const values = valuesFor(email);
  const subject = fillSubject(copy.subject, values, spec.defaults.subject);
  const message = fillMessage(copy.message, values, ["leave_type"]);
  const p = spec.details?.(email) ?? {};
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
  const [lead, ...more] = message.text;
  const text = [
    lead,
    ...(p.quote ? ["", quoted(p.quote)] : []),
    ...(p.overlap ? ["", p.overlap] : []),
    ...(extra ? ["", extra] : []),
    ...more.flatMap((paragraph) => ["", paragraph]),
    "",
    ...(approveLink
      ? [`Approve: ${approveLink}`, `Decline or look closer in OOOhm: ${link}`]
      : [`${actions[0].label}: ${link}`]),
    ...(approveNote ? ["", approveNote] : []),
    "",
  ].join("\n");

  const [leadHtml, ...moreHtml] = message.html;
  const body =
    heading(leadHtml) +
    (p.quote ? paragraph(escapeHtml(quoted(p.quote)), `color:${BODY};white-space:pre-wrap`) : "") +
    (p.overlap ? paragraph(dot(accent) + escapeHtml(p.overlap), `color:${BODY};font-size:15px`) : "") +
    (p.extra
      ? paragraph(
          `<span style="color:${MUTED}">${escapeHtml(p.extra.label)}:</span> ` +
            escapeHtml(p.extra.quoted ? quoted(p.extra.value) : p.extra.value),
          `color:${BODY};white-space:pre-wrap`,
        )
      : "") +
    moreHtml.map((html) => paragraph(html)).join("") +
    buttons(actions, accent);

  return { subject, text, html: emailDocument(body, accent, approveNote ? escapeHtml(approveNote) : undefined, subject) };
}
