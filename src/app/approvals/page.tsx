import type { Metadata } from "next";
import { APPROVALS_VIEW_PARAM, getApprovalTriage, presentApprovals, readApprovalsView } from "@/modules/approvals";
import { AppPage } from "@/components/layout/app-page";
import { NoCompany } from "@/components/layout/no-company";
import { Pager } from "@/components/navigation/pager";
import { TabNav } from "@/components/navigation/tab-nav";
import { requireMemberPage } from "@/app/_lib/page-context";
import { listHref, pagerLinks, readPageParams } from "@/app/_lib/paging";
import { PendingList } from "./pending-list";
import { SettledList } from "./settled-list";

export const metadata: Metadata = { title: "Approvals · OOOhm" };

const PATH = "/approvals";

/**
 * Approvals, sorted by whose move it is: Needs you, Waiting on others (admins, when
 * anything is), and Settled (what the person decided lately). Each tab pages ten at a
 * time; each request says who else in the requester's department is off then.
 */
export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const page = await requireMemberPage();
  if (!page.actor) return <NoCompany nav={page.nav} current="approvals" />;

  const { actor } = page;
  const params = await searchParams;
  const { cursor, number } = readPageParams(params);
  const triage = await getApprovalTriage(page.ctx, actor, { view: readApprovalsView(params.view), page: cursor });
  const { view, tabs, empty } = presentApprovals(triage, (v) => listHref(PATH, { view: v }));
  const pager = pagerLinks(PATH, triage, number, { keep: { view: APPROVALS_VIEW_PARAM[view] } });

  return (
    <AppPage nav={page.nav} current="approvals" title="Approvals">
      <TabNav label="Approvals" items={tabs} />

      {view === "settled" ? (
        <>
          <SettledList decisions={triage.settled} days={triage.settledDays} timeZone={triage.timeZone} firstPage={!triage.previous} />
          <Pager label="Settled pages" links={pager} />
        </>
      ) : (
        <>
          {view === "others" && <p className="text-sm text-muted">Assigned to someone else. As an admin you can still decide them.</p>}
          {triage.items.length === 0 ? <p className="text-muted">{empty}</p> : <PendingList items={triage.items} viewerId={actor.id} />}
          <Pager label="Approvals pages" links={pager} />
        </>
      )}
    </AppPage>
  );
}
