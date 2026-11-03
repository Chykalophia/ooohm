import type { Metadata } from "next";
import { formatDays, formatLeaveDates } from "@/lib/format";
import { listApprovalInbox } from "@/server/services/approvals";
import { AppPage } from "@/components/layout/app-page";
import { NoCompany } from "@/components/layout/no-company";
import { Card } from "@/components/ui/card";
import { ColorLabel } from "@/components/ui/color-label";
import { Pager } from "@/components/navigation/pager";
import { requireMemberPage } from "@/app/_lib/page-context";
import { pagerLinks, readPageParams } from "@/app/_lib/paging";
import { DecisionForm } from "./decision-form";

export const metadata: Metadata = { title: "Approvals · OOOhm" };

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const page = await requireMemberPage();
  if (!page.actor) return <NoCompany nav={page.nav} current="approvals" />;

  const { actor } = page;
  const { cursor, number } = readPageParams(await searchParams);
  const inbox = await listApprovalInbox(page.ctx, actor, { page: cursor });
  const { items, total } = inbox;
  const pager = pagerLinks("/approvals", inbox, number);

  return (
    <AppPage nav={page.nav} current="approvals" title="Approvals">
      {items.length === 0 ? (
        <>
          {/* A later page emptied by deciding what was on it: the earlier pages still wait. */}
          <p className="text-muted">{inbox.previous ? "Nothing on this page is waiting for you now." : "Nothing is waiting for you."}</p>
          <Pager label="Approvals pages" links={pager} />
        </>
      ) : (
        <>
          {total > items.length && <p className="text-sm text-muted">{total} waiting, earliest dates first.</p>}
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
                  {r.alsoOff && <p className="text-sm text-muted break-words">Also off then: {r.alsoOff}</p>}
                </div>
                <DecisionForm requestId={r.id} />
              </Card>
            ))}
          </ul>
          <Pager label="Approvals pages" links={pager} />
        </>
      )}
    </AppPage>
  );
}
