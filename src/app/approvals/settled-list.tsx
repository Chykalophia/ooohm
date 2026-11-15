import { presentSettledDecision, type SettledDecisionDTO } from "@/modules/approvals";
import { StatusBadge } from "@/components/leave/status-badge";
import { ColorLabel } from "@/components/ui/color-label";
import { cx, surface } from "@/components/ui/styles";

/** What the person approved or declined in the last `days` days, newest first, each with its status now. */
export function SettledList({
  decisions,
  days,
  timeZone,
  firstPage,
}: {
  decisions: readonly SettledDecisionDTO[];
  days: number;
  timeZone: string;
  firstPage: boolean;
}) {
  if (decisions.length === 0) {
    return (
      <p className="text-muted">{firstPage ? `You haven’t decided anything in the last ${days} days.` : "Nothing more on this page."}</p>
    );
  }
  return (
    <>
      <p className="text-sm text-muted">What you decided in the last {days} days, newest first.</p>
      <ul className={cx("divide-y divide-border", surface)}>
        {decisions.map((d) => {
          const view = presentSettledDecision(d, timeZone);
          return (
            <li key={d.auditId} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <p className="font-medium break-words">{view.who}</p>
                <ColorLabel color={d.leaveTypeColor}>{view.dates}</ColorLabel>
                <p className="text-sm text-muted">{view.summary}</p>
                {d.decisionNote && (
                  <p className="text-sm break-words">
                    <span className="text-muted">Your note: </span>
                    {d.decisionNote}
                  </p>
                )}
              </div>
              <div className="shrink-0">
                <StatusBadge status={d.status} />
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
