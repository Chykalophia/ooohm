import Link from "next/link";
import { formatDays, formatLeaveDates, formatTypicalWait } from "@/lib/format";
import { ColorLabel } from "@/components/ui/color-label";
import { cx } from "@/components/ui/styles";
import { StatusBadge } from "./status-badge";

/** What a request card shows: one of the person's own requests. */
export type RequestCardData = {
  id: string;
  startDate: string;
  endDate: string;
  dayPortion: "full" | "am" | "pm";
  days: number;
  status: "pending" | "approved" | "rejected" | "cancelled";
  note: string | null;
  decisionNote: string | null;
  leaveTypeName: string;
  leaveTypeColor: string;
  approverId: string | null;
  approverName: string | null;
  /** How long the approver usually takes, in hours, while the request waits on them; absent or `null` to say nothing. */
  typicalWaitHours?: number | null;
};

/**
 * One of the person's own requests as a card that opens it (`href`, its own page): the
 * dates, type and days, the notes, and its status. The whole card is the link (its dates
 * are, stretched over it), so it lifts a little on hover and shows the focus ring around
 * itself; `action` (Cancel request) sits above the link and stays its own target.
 *
 * @param me The person looking: "with Ana" is left out when they decide their own.
 */
export function RequestCard({
  request: r,
  me,
  href,
  action,
}: {
  request: RequestCardData;
  me: string;
  href: string;
  action?: React.ReactNode;
}) {
  const dates = formatLeaveDates(r.startDate, r.endDate, r.dayPortion);
  return (
    <li
      className={cx(
        "group relative rounded-2xl border border-border bg-surface p-4 transition duration-150",
        "hover:border-foreground/25 hover:shadow-md motion-safe:hover:-translate-y-0.5",
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <ColorLabel color={r.leaveTypeColor} className="font-medium">
            <Link
              href={href}
              className={cx(
                "outline-none after:absolute after:inset-0 after:rounded-2xl",
                "focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-accent-ink",
              )}
            >
              {dates}
            </Link>
            <span aria-hidden className="text-muted transition-transform group-hover:translate-x-0.5">
              ›
            </span>
          </ColorLabel>
          <p className="text-sm text-muted">
            {r.leaveTypeName} · {formatDays(r.days)}
            {r.status === "pending" && r.approverName && r.approverId !== me && ` · with ${r.approverName}`}
            {r.status === "pending" && r.approverName && r.approverId !== me && r.typicalWaitHours != null && `, who ${formatTypicalWait(r.typicalWaitHours)}`}
          </p>
          {r.note && <p className="text-sm break-words text-muted">{r.note}</p>}
          {r.decisionNote && (
            <p className="text-sm break-words">
              <span className="text-muted">{r.status === "rejected" ? "Reason: " : "Note from approver: "}</span>
              {r.decisionNote}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-start gap-2 sm:max-w-60 sm:items-end">
          <StatusBadge status={r.status} />
          {/* Above the stretched link, so it is a target of its own. */}
          {action && <div className="relative z-10">{action}</div>}
        </div>
      </div>
    </li>
  );
}
