import { type InboxItemDTO, presentPendingRequest } from "@/modules/approvals";
import { ColorLabel } from "@/components/ui/color-label";
import { cx } from "@/components/ui/styles";
import { ApprovalItem } from "./approval-item";
import { ApprovalKeys } from "./approval-keys";

/** The pending requests of a tab, each with its decision, who else is off and the coverage warning. */
export function PendingList({ items, viewerId }: { items: readonly InboxItemDTO[]; viewerId: string }) {
  return (
    <>
      {/* J and K move between these, A approves, D starts a decline, once turned on. */}
      <ApprovalKeys userId={viewerId} />
      <ul className="space-y-4">
        {items.map((r) => {
          const view = presentPendingRequest(r, viewerId);
          return (
            <ApprovalItem key={r.id} requestId={r.id} label={view.label} who={view.who} dates={view.dates}>
              <div className="space-y-1">
                <p className="font-medium break-words">
                  {view.who}
                  {/* A real space, so a screen reader doesn't run the name into the email. */}
                  {r.requesterName && " "}
                  {r.requesterName && <span className="ml-1 text-sm font-normal text-muted">{r.requesterEmail}</span>}
                </p>
                <ColorLabel color={r.leaveTypeColor}>{view.dates}</ColorLabel>
                <p className="text-sm text-muted">{view.summary}</p>
                {r.note && <p className="text-sm break-words">{r.note}</p>}
                {r.alsoOff?.coverage && <p className="text-sm font-medium break-words">{r.alsoOff.coverage}</p>}
                {r.alsoOff && <p className={cx("text-sm break-words", r.alsoOff.others > 0 ? "font-medium" : "text-muted")}>{r.alsoOff.line}</p>}
              </div>
            </ApprovalItem>
          );
        })}
      </ul>
    </>
  );
}
