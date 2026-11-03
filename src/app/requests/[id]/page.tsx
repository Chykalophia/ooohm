import type { Metadata } from "next";
import { formatDays, formatInstantDateTime, formatLeaveDates } from "@/lib/format";
import { getMyRequest } from "@/server/services/leave-requests";
import { AppPage } from "@/components/layout/app-page";
import { NoCompany } from "@/components/layout/no-company";
import { StatusBadge } from "@/components/leave/status-badge";
import { Card } from "@/components/ui/card";
import { ColorLabel } from "@/components/ui/color-label";
import { BackLink } from "@/components/ui/section";
import { surface } from "@/components/ui/styles";
import { orNotFound, requireMemberPage } from "@/app/_lib/page-context";
import { CancelRequest } from "@/app/requests/cancel-request";

export const metadata: Metadata = { title: "Request · OOOhm" };

/** Focus lands on the status after a cancel: the Cancel button goes, the new status shows here. */
const STATUS_ID = "request-status";

/** What the approver line says, by status: who it waits for, or who decided it. */
const APPROVER_LABEL = { pending: "Waiting for", approved: "Approved by", rejected: "Declined by", cancelled: "Approver" } as const;

const PORTION: Record<"full" | "am" | "pm", string> = { full: "Full days", am: "Morning only", pm: "Afternoon only" };

/**
 * One of the person's own requests in full: the leave, its status, who decides it and
 * what they said, when it was sent and decided (date and time, in the company's zone:
 * the order of events can matter), and Cancel request while it can be.
 * Someone else's request is not found (404), as an unknown one is.
 */
export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const page = await requireMemberPage();
  if (!page.actor) return <NoCompany nav={page.nav} current="requests" />;

  const { id } = await params;
  const { request: r, timezone } = await orNotFound(getMyRequest(page.ctx, page.actor, id));
  const me = page.actor.id;
  const dates = formatLeaveDates(r.startDate, r.endDate, r.dayPortion);
  const approver = r.approverId === me ? "You (you approve your own requests)" : (r.approverName ?? "Nobody yet");

  const facts: [string, React.ReactNode][] = [
    [
      "Type",
      <ColorLabel key="type" as="span" color={r.leaveTypeColor}>
        {r.leaveTypeName}
      </ColorLabel>,
    ],
    [
      "Days",
      `${formatDays(r.days)}${r.startDate === r.endDate && r.dayPortion !== "full" ? ` (${PORTION[r.dayPortion].toLowerCase()})` : ""}`,
    ],
    [APPROVER_LABEL[r.status], approver],
    ["Sent", formatInstantDateTime(r.createdAt, timezone)],
    ...(r.decidedAt
      ? [[r.status === "rejected" ? "Declined" : "Decided", formatInstantDateTime(r.decidedAt, timezone)] as [string, React.ReactNode]]
      : []),
    ...(r.note ? [["Your note", r.note] as [string, React.ReactNode]] : []),
    ...(r.decisionNote ? [[r.status === "rejected" ? "Reason" : "Note from approver", r.decisionNote] as [string, React.ReactNode]] : []),
  ];

  return (
    <AppPage nav={page.nav} current="requests" title={dates}>
      <BackLink href="/requests">← Your requests</BackLink>
      <Card className={surface}>
        <div className="space-y-5">
          <p id={STATUS_ID} tabIndex={-1} className="outline-none">
            <StatusBadge status={r.status} />
          </p>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[9rem_1fr]">
            {facts.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted">{label}</dt>
                <dd className="min-w-0 break-words">{value}</dd>
              </div>
            ))}
          </dl>
          {r.cancellable && (
            <div className="border-t border-border pt-4">
              <CancelRequest request={r} focusOnSuccess={STATUS_ID} />
            </div>
          )}
        </div>
      </Card>
    </AppPage>
  );
}
