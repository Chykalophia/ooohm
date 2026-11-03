import { formatDays, formatLeaveDates } from "@/lib/format";
import { getDashboard } from "@/server/services/leave-requests";
import { InlineAction } from "@/components/forms/inline-action";
import { AppPage } from "@/components/layout/app-page";
import { NoCompany } from "@/components/layout/no-company";
import { BalanceSummary } from "@/components/leave/balance-summary";
import { StatusBadge } from "@/components/leave/status-badge";
import { Item, ItemList } from "@/components/ui/card";
import { ColorLabel } from "@/components/ui/color-label";
import { Section } from "@/components/ui/section";
import { Pager } from "@/components/navigation/pager";
import { requireMemberPage } from "./_lib/page-context";
import { pagerLinks, readPageParams } from "./_lib/paging";
import { cancelLeaveAction } from "./actions";
import { RequestLeaveForm } from "./request-leave-form";

/** Focus lands on this heading after a cancel, when the cancel button itself disappears. */
const REQUESTS_HEADING_ID = "mine-heading";

export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const page = await requireMemberPage();
  if (!page.actor) return <NoCompany nav={page.nav} current="home" />;

  const { actor } = page;
  const { cursor, number } = readPageParams(await searchParams);
  const dashboard = await getDashboard(page.ctx, actor, cursor);
  // The links land on the list, not the top of the page.
  const pager = pagerLinks("/", dashboard.requestPages, number, { fragment: REQUESTS_HEADING_ID });

  return (
    <AppPage nav={page.nav} current="home" title="Your time off" titleHidden className="space-y-10">
      {dashboard.leaveTypes.length === 0 ? (
        <p className="text-muted">No leave types yet. An admin needs to set them up.</p>
      ) : (
        <RequestLeaveForm leaveTypes={dashboard.leaveTypes} defaultDate={dashboard.defaultDate} />
      )}

      <BalanceSummary summary={dashboard.balances} />

      <Section title="Your requests" headingId={REQUESTS_HEADING_ID}>
        {dashboard.requests.length === 0 ? (
          <p className="text-muted">{dashboard.requestPages.previous ? "No more requests." : "Nothing yet. Your requests will show up here."}</p>
        ) : (
          <ItemList>
            {dashboard.requests.map((r) => (
              <Item key={r.id} className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <ColorLabel color={r.leaveTypeColor} className="font-medium">
                    {formatLeaveDates(r.startDate, r.endDate, r.dayPortion)}
                  </ColorLabel>
                  <p className="text-sm text-muted">
                    {r.leaveTypeName} · {formatDays(r.days)}
                    {r.status === "pending" && r.approverName && r.approverId !== actor.id && ` · with ${r.approverName}`}
                  </p>
                  {r.note && <p className="text-sm text-muted break-words">{r.note}</p>}
                  {r.decisionNote && (
                    <p className="text-sm break-words">
                      <span className="text-muted">{r.status === "rejected" ? "Reason: " : "Note from approver: "}</span>
                      {r.decisionNote}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                  <StatusBadge status={r.status} />
                  {r.cancellable && (
                    // Two steps, so approved time off is never dropped by a stray click.
                    <InlineAction
                      action={cancelLeaveAction}
                      fields={{ requestId: r.id }}
                      label="Cancel"
                      ariaLabel={`Cancel ${formatLeaveDates(r.startDate, r.endDate, r.dayPortion)}`}
                      pendingLabel="Cancelling…"
                      confirm="Cancel this request?"
                      confirmLabel="Yes, cancel it"
                      confirmVariant="danger"
                      showSuccess={false}
                      focusOnSuccess={REQUESTS_HEADING_ID}
                    />
                  )}
                </div>
              </Item>
            ))}
          </ItemList>
        )}
        <Pager label="Your requests pages" links={pager} />
      </Section>
    </AppPage>
  );
}
