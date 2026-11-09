import type { Metadata } from "next";
import Link from "next/link";
import { listMyRequests } from "@/server/services/leave-requests";
import { AppPage } from "@/components/layout/app-page";
import { NoCompany } from "@/components/layout/no-company";
import { Pager } from "@/components/navigation/pager";
import { buttonClass } from "@/components/ui/styles";
import { REQUEST_FORM_ID } from "@/components/layout/anchors";
import { requireMemberPage } from "@/app/_lib/page-context";
import { pagerLinks, readPageParams } from "@/app/_lib/paging";
import { RequestList } from "./request-list";

export const metadata: Metadata = { title: "Your requests · OOOhm" };

/** Focus lands on this heading after a cancel, when the cancel button itself disappears. */
const HEADING_ID = "requests-heading";

/** Every request the person has sent, latest dates first, a page at a time; each opens its own page. */
export default async function RequestsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const page = await requireMemberPage();
  if (!page.actor) return <NoCompany nav={page.nav} current="requests" />;

  const { cursor, number } = readPageParams(await searchParams);
  const requests = await listMyRequests(page.ctx, page.actor, cursor);
  const pager = pagerLinks("/requests", requests, number);

  return (
    <AppPage
      nav={page.nav}
      current="requests"
      title={
        <span id={HEADING_ID} tabIndex={-1} className="outline-none">
          Your requests
        </span>
      }
      description="Everything you've asked for, latest dates first. Open one to see it in full, or cancel it while it's waiting, or until approved time off is over."
    >
      {requests.items.length === 0 ? (
        requests.previous ? (
          <p className="text-muted">No more requests.</p>
        ) : (
          <div className="space-y-4">
            <p className="text-muted">Nothing yet. Your requests will show up here.</p>
            <Link href={`/#${REQUEST_FORM_ID}`} className={buttonClass("accent", "sm")}>
              Request time off
            </Link>
          </div>
        )
      ) : (
        <RequestList requests={requests.items} me={page.actor.id} focusAfterCancel={HEADING_ID} />
      )}
      <Pager label="Your requests pages" links={pager} />
    </AppPage>
  );
}
