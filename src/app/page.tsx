import type { Metadata } from "next";
import Link from "next/link";
import { formatExpiring } from "@/lib/format";
import { hasPasskey } from "@/server/services/account";
import { shouldSuggestCalendarFeed } from "@/server/services/calendar-feeds";
import { getDashboard } from "@/server/services/leave-requests";
import { AppPage } from "@/components/layout/app-page";
import { NoCompany } from "@/components/layout/no-company";
import { BalanceSummary } from "@/components/leave/balance-summary";
import { Section } from "@/components/ui/section";
import { quietLink } from "@/components/ui/styles";
import { requestAppearance } from "./_lib/appearance";
import { requireMemberPage } from "./_lib/page-context";
import { HomeHint } from "./home-hint";
import { RequestLeaveForm } from "./request-leave-form";
import { RequestLeaveSentence } from "./request-leave-sentence";
import { RequestList } from "./requests/request-list";

export const metadata: Metadata = { title: "Your time off · OOOhm" };

/** Focus lands on this heading after a cancel, when the cancel button itself disappears. */
const REQUESTS_HEADING_ID = "mine-heading";

export default async function HomePage() {
  const page = await requireMemberPage();
  if (!page.actor) return <NoCompany nav={page.nav} current="home" />;

  const { actor } = page;
  // Once someone has approved time off, suggest putting it in their own calendar, until they have.
  // Until someone has a passkey, suggest one: signing in is then a tap instead of an email.
  const [dashboard, suggestFeed, appearance, passkeyAdded] = await Promise.all([
    getDashboard(page.ctx, actor),
    shouldSuggestCalendarFeed(page.ctx, actor),
    requestAppearance(),
    hasPasskey(page.ctx, actor),
  ]);
  // The admin's choice under Appearance; both send the same request.
  const RequestLeave = appearance.requestStyle === "sentence" ? RequestLeaveSentence : RequestLeaveForm;

  return (
    <AppPage nav={page.nav} current="home" title="Your time off" titleHidden className="space-y-10">
      {dashboard.leaveTypes.length === 0 ? (
        <p className="text-muted">No leave types yet. An admin needs to set them up.</p>
      ) : (
        <RequestLeave leaveTypes={dashboard.leaveTypes} defaultDate={dashboard.defaultDate} headsUp={dashboard.approvalMode === "heads_up"} />
      )}

      {!passkeyAdded && (
        <HomeHint storageKey={`ooohm:${actor.companyId}:${actor.id}:passkey`} link={{ href: "/account#passkeys", label: "Add a passkey" }}>
          Sign in faster next time: with a passkey, it&apos;s your fingerprint, face or device PIN instead of an email.
        </HomeHint>
      )}

      {dashboard.expiring.length > 0 && dashboard.balances && (
        <HomeHint
          storageKey={`ooohm:${actor.companyId}:${actor.id}:expiring:${dashboard.balances.year}`}
          link={{ href: "/calendar", label: "Pick days" }}
        >
          {formatExpiring(dashboard.expiring, dashboard.balances.year + 1)} Book them by December 31.
        </HomeHint>
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
        {suggestFeed && (
          <HomeHint
            storageKey={`ooohm:${actor.companyId}:${actor.id}:calendar-feed`}
            link={{ href: "/calendar/subscriptions", label: "Add to my calendar" }}
          >
            Put your time off in Google Calendar, Apple Calendar or Outlook, and keep it up to date there.
          </HomeHint>
        )}
        {dashboard.requests.length === 0 ? (
          <p className="text-muted">Nothing yet. Your requests will show up here.</p>
        ) : (
          <RequestList requests={dashboard.requests} me={actor.id} focusAfterCancel={REQUESTS_HEADING_ID} />
        )}
      </Section>
    </AppPage>
  );
}
