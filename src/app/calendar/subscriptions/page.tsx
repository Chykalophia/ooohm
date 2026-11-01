import type { Metadata } from "next";
import { requireActor } from "@/lib/auth";
import { formatInstantDate } from "@/lib/format";
import { serviceContext } from "@/server/runtime";
import { getApprovalNav } from "@/server/services/approvals";
import { type FeedSummary, listCalendarFeeds } from "@/server/services/calendar-feeds";
import { AppHeader } from "@/app/app-header";
import { NoCompany } from "@/app/no-company";
import { FeedCard, type FeedStatus } from "./feed-card";

export const metadata: Metadata = { title: "Calendar subscriptions · OOOhm" };

export default async function SubscriptionsPage() {
  const { user, actor } = await requireActor();
  const userName = user.name || user.email;
  if (!actor) return <NoCompany userName={userName} current="calendar" />;

  const ctx = serviceContext();
  const [{ timezone, feeds }, approvals] = await Promise.all([listCalendarFeeds(ctx, actor), getApprovalNav(ctx, actor)]);
  const statusOf = (feed: FeedSummary | null): FeedStatus | null =>
    feed && {
      since: formatInstantDate(feed.createdAt, timezone),
      lastUsed: feed.lastUsedAt ? formatInstantDate(feed.lastUsedAt, timezone) : null,
    };

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
      <AppHeader userName={userName} approvals={approvals} current="calendar" />

      <main className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Calendar subscriptions</h1>
          <p className="text-muted">
            See time off in Google Calendar, Apple Calendar or Outlook. Each calendar gets a private link: anyone who has it
            can see that calendar.
          </p>
        </div>

        <FeedCard
          kind="personal"
          title="Your time off"
          description="Your approved and pending requests."
          status={statusOf(feeds.personal)}
        />
        <FeedCard
          kind="team"
          title="Who's out"
          description="Everyone's approved and pending time off: names, dates and leave types, never notes."
          status={statusOf(feeds.team)}
        />

        <section aria-labelledby="how-heading" className="space-y-2 text-sm text-muted">
          <h2 id="how-heading" className="font-medium text-foreground">
            Adding a link
          </h2>
          <ul className="space-y-1">
            <li>Google Calendar: Other calendars, then +, then From URL.</li>
            <li>Apple Calendar: File, then New Calendar Subscription.</li>
            <li>Outlook: Add calendar, then Subscribe from web.</li>
          </ul>
          <p>Google checks for changes on its own schedule, which can take up to a day.</p>
        </section>
      </main>
    </div>
  );
}
