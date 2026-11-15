import { formatDays, formatInstantDate, formatLeaveDates } from "@/lib/format";
import type { ApprovalsView, ApprovalTriageDTO, InboxItemDTO, SettledDecisionDTO } from "../application/dto";

/** The `?view=` of each tab; Needs you is the page itself. */
export const APPROVALS_VIEW_PARAM: Record<ApprovalsView, string | undefined> = { mine: undefined, others: "waiting", settled: "settled" };

/** The tab a `?view=` asks for; Needs you for anything else. */
export function readApprovalsView(value: string | string[] | undefined): ApprovalsView {
  const v = Array.isArray(value) ? value[0] : value;
  return v === "waiting" ? "others" : v === "settled" ? "settled" : "mine";
}

export type ApprovalTab = { href: string; label: string; count?: number; current: boolean };

/** The Approvals page's tabs and empty-tab wording. */
export interface ApprovalsPresentation {
  /** The tab shown: Waiting on others shows only when something is there; a link to an empty tab adds noise. */
  view: ApprovalsView;
  tabs: ApprovalTab[];
  /** What an empty pending tab says. */
  empty: string;
}

/** @param href A link to a tab's `?view=` (the page's own path). */
export function presentApprovals(triage: ApprovalTriageDTO, href: (view: string | undefined) => string): ApprovalsPresentation {
  const view = triage.view === "others" && triage.waitingTotal === 0 && !triage.previous ? "mine" : triage.view;
  const tab = (v: ApprovalsView) => href(APPROVALS_VIEW_PARAM[v]);
  const tabs: ApprovalTab[] = [
    { href: tab("mine"), label: "Needs you", count: triage.needsYouTotal, current: view === "mine" },
    ...(triage.waitingTotal > 0 || view === "others"
      ? [{ href: tab("others"), label: "Waiting on others", count: triage.waitingTotal, current: view === "others" }]
      : []),
    { href: tab("settled"), label: "Settled", current: view === "settled" },
  ];
  const waiting = triage.waitingTotal;
  const empty = triage.previous
    ? "Nothing on this page is waiting for you now."
    : view === "others"
      ? "Nothing is waiting on anyone else."
      : waiting > 0
        ? `Nothing needs you right now. ${waiting === 1 ? "One request is" : `${waiting} requests are`} waiting on someone else.`
        : "Nothing needs you right now.";
  return { view, tabs, empty };
}

/** A pending request's lines on the Approvals page. */
export interface PendingRequestView {
  who: string;
  dates: string;
  /** The item's accessible name. */
  label: string;
  /** Leave type and days, and who it is assigned to when that is someone else. */
  summary: string;
}

export function presentPendingRequest(r: InboxItemDTO, viewerId: string): PendingRequestView {
  const who = r.requesterName || r.requesterEmail;
  const dates = formatLeaveDates(r.startDate, r.endDate, r.dayPortion);
  const assigned = r.approverId && r.approverId !== viewerId ? ` · Assigned to ${r.approverName || "someone else"}` : "";
  return { who, dates, label: `Request from ${who}, ${dates}`, summary: `${r.leaveTypeName} · ${formatDays(r.days)}${assigned}` };
}

/** A decision's lines on the Settled tab. */
export function presentSettledDecision(d: SettledDecisionDTO, timeZone: string): { who: string; dates: string; summary: string } {
  return {
    who: d.requesterName || d.requesterEmail,
    dates: formatLeaveDates(d.startDate, d.endDate, d.dayPortion),
    summary: `${d.leaveTypeName} · ${formatDays(d.days)} · ${d.decision === "approved" ? "Approved" : "Declined"} by you on ${formatInstantDate(d.decidedAt, timeZone)}`,
  };
}
