import type { Metadata } from "next";
import { formatDays, formatLeaveDates } from "@/lib/format";
import { listApprovalInbox } from "@/server/services/approvals";
import { AppPage } from "@/components/layout/app-page";
import { NoCompany } from "@/components/layout/no-company";
import { Card } from "@/components/ui/card";
import { ColorLabel } from "@/components/ui/color-label";
import { requireMemberPage } from "@/app/_lib/page-context";
import { DecisionForm } from "./decision-form";

export const metadata: Metadata = { title: "Approvals · OOOhm" };

export default async function ApprovalsPage() {
  const page = await requireMemberPage();
  if (!page.actor) return <NoCompany nav={page.nav} current="approvals" />;

  const { actor } = page;
  const { items, total } = await listApprovalInbox(page.ctx, actor);

  return (
    <AppPage nav={page.nav} current="approvals" title="Approvals">
      {items.length === 0 ? (
        <p className="text-muted">Nothing is waiting for you.</p>
      ) : (
        <>
          {total > items.length && (
            <p className="text-sm text-muted">
              Showing the first {items.length} of {total}, earliest dates first. Decide these to see the rest.
            </p>
          )}
          <ul className="space-y-4">
            {items.map((r) => (
              <Card as="li" key={r.id} className="space-y-4">
                <div className="space-y-1">
                  <p className="font-medium break-words">
                    {r.requesterName || r.requesterEmail}
                    {r.requesterName && <span className="ml-2 text-sm font-normal text-muted">{r.requesterEmail}</span>}
                  </p>
                  <ColorLabel color={r.leaveTypeColor}>{formatLeaveDates(r.startDate, r.endDate, r.dayPortion)}</ColorLabel>
                  <p className="text-sm text-muted">
                    {r.leaveTypeName} · {formatDays(r.days)}
                    {r.approverId !== actor.id && ` · Assigned to ${r.approverName || "someone else"}`}
                  </p>
                  {r.note && <p className="text-sm break-words">{r.note}</p>}
                  {r.alsoOff && <p className="text-sm text-muted">Also off then: {r.alsoOff}</p>}
                </div>
                <DecisionForm requestId={r.id} />
              </Card>
            ))}
          </ul>
        </>
      )}
    </AppPage>
  );
}
