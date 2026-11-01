import { displayName } from "@/domain/person";
import { formatDays, formatLeaveDates } from "@/lib/format";

export { displayName, personLabel } from "@/domain/person";

/**
 * Leave notification emails: calm plain text plus a minimal HTML twin.
 *
 * Subjects are fixed strings. Names, notes and reasons are typed by people, so they
 * appear only in the body (HTML-escaped there) and never in a header, which rules out
 * header injection however the transport handles newlines.
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
  | { kind: "requested"; recipientName: string; leave: LeaveSummary; link: string }
  | { kind: "approved"; recipientName: string; leave: LeaveSummary; reason: string | null; link: string }
  | { kind: "rejected"; recipientName: string; leave: LeaveSummary; reason: string | null; link: string }
  | { kind: "cancelled_requester"; recipientName: string; leave: LeaveSummary; link: string }
  | { kind: "cancelled_approver"; recipientName: string; leave: LeaveSummary; link: string };

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface Parts {
  subject: string;
  intro: string;
  /** Extra labelled line after the details, e.g. a decline reason. */
  extra?: { label: string; value: string };
  showNote: boolean;
  action: string;
}

function parts(email: LeaveEmail): Parts {
  const { leave } = email;
  switch (email.kind) {
    case "requested":
      return {
        subject: "Time off request to review",
        intro: `${leave.requesterName} asked for time off.`,
        showNote: true,
        action: "Review it in OOOhm",
      };
    case "approved":
      return {
        subject: "Your time off is approved",
        intro: "Your time off is approved.",
        extra: email.reason ? { label: "Note from approver", value: email.reason } : undefined,
        showNote: false,
        action: "Open OOOhm",
      };
    case "rejected":
      return {
        subject: "Your time off request was declined",
        intro: "Your time off request was declined.",
        extra: email.reason ? { label: "Reason", value: email.reason } : undefined,
        showNote: false,
        action: "Open OOOhm",
      };
    case "cancelled_requester":
      return {
        subject: "Your time off request was cancelled",
        intro: "Your time off request was cancelled.",
        showNote: false,
        action: "Open OOOhm",
      };
    case "cancelled_approver":
      return {
        subject: "A time off request was cancelled",
        intro: `${leave.requesterName} cancelled their time off. Nothing else is needed from you.`,
        showNote: false,
        action: "Open OOOhm",
      };
  }
}

export function renderLeaveEmail(input: LeaveEmail): EmailContent {
  const email: LeaveEmail = {
    ...input,
    recipientName: displayName(input.recipientName),
    leave: { ...input.leave, requesterName: displayName(input.leave.requesterName) },
  };
  const { leave, link, recipientName } = email;
  const p = parts(email);
  const details: { label: string; value: string }[] = [
    { label: "Type", value: leave.leaveTypeName },
    { label: "Dates", value: formatLeaveDates(leave.startDate, leave.endDate, leave.dayPortion) },
    { label: "Days", value: formatDays(leave.days) },
  ];
  if (p.showNote && leave.note) details.push({ label: "Note", value: leave.note });
  if (p.extra) details.push(p.extra);

  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,";
  const text = [
    greeting,
    "",
    p.intro,
    "",
    ...details.map((d) => `${d.label}: ${d.value}`),
    "",
    `${p.action}: ${link}`,
    "",
  ].join("\n");

  const rows = details
    .map(
      (d) =>
        `<tr><td style="padding:2px 16px 2px 0;color:#78716c;vertical-align:top">${escapeHtml(d.label)}</td>` +
        `<td style="padding:2px 0;white-space:pre-wrap">${escapeHtml(d.value)}</td></tr>`,
    )
    .join("");
  const html =
    `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#1c1917;line-height:1.5;max-width:480px">` +
    `<p>${escapeHtml(greeting)}</p>` +
    `<p>${escapeHtml(p.intro)}</p>` +
    `<table style="border-collapse:collapse;margin:16px 0">${rows}</table>` +
    `<p><a href="${escapeHtml(link)}" style="color:#0f766e">${escapeHtml(p.action)}</a></p>` +
    `</div>`;

  return { subject: p.subject, text, html };
}
