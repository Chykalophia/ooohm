import Link from "next/link";
import { getDashboard } from "@/server/services/leave-requests";
import { AppPage } from "@/components/layout/app-page";
import { NoCompany } from "@/components/layout/no-company";
import { BalanceSummary } from "@/components/leave/balance-summary";
import { Section } from "@/components/ui/section";
import { quietLink } from "@/components/ui/styles";
import { requireMemberPage } from "./_lib/page-context";
import { RequestLeaveForm } from "./request-leave-form";
import { RequestList } from "./requests/request-list";

/** Focus lands on this heading after a cancel, when the cancel button itself disappears. */
const REQUESTS_HEADING_ID = "mine-heading";

export default async function HomePage() {
  const page = await requireMemberPage();
  if (!page.actor) return <NoCompany nav={page.nav} current="home" />;

  const { actor } = page;
  const dashboard = await getDashboard(page.ctx, actor);

  return (
    <AppPage nav={page.nav} current="home" title="Your time off" titleHidden className="space-y-10">
      {dashboard.leaveTypes.length === 0 ? (
        <p className="text-muted">No leave types yet. An admin needs to set them up.</p>
      ) : (
        <RequestLeaveForm leaveTypes={dashboard.leaveTypes} defaultDate={dashboard.defaultDate} />
      )}

      <BalanceSummary summary={dashboard.balances} />

      {/* The latest few; every request, a page at a time, is on "Your requests". */}
      <Section
        title="Your latest requests"
        headingId={REQUESTS_HEADING_ID}
        action={
          dashboard.requests.length > 0 && (
            <Link href="/requests" className={quietLink}>
              {dashboard.moreRequests ? "See all your requests →" : "Your requests →"}
            </Link>
          )
        }
      >
        {dashboard.requests.length === 0 ? (
          <p className="text-muted">Nothing yet. Your requests will show up here.</p>
        ) : (
          <RequestList requests={dashboard.requests} me={actor.id} focusAfterCancel={REQUESTS_HEADING_ID} />
        )}
      </Section>
    </AppPage>
  );
}
