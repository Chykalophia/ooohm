import type { Metadata } from "next";
import { formatInstantDate } from "@/lib/format";
import { type FeedSummary, listCalendarFeeds } from "@/server/services/calendar-feeds";
import { AppPage } from "@/components/layout/app-page";
import { NoCompany } from "@/components/layout/no-company";
import { Section } from "@/components/ui/section";
import { requireMemberPage } from "@/app/_lib/page-context";
import { FeedCard, type FeedStatus } from "./feed-card";

export const metadata: Metadata = { title: "Calendar subscriptions · OOOhm" };

export default async function SubscriptionsPage() {
  const page = await requireMemberPage();
  if (!page.actor) return <NoCompany nav={page.nav} current="calendar" />;

  const { timezone, feeds } = await listCalendarFeeds(page.ctx, page.actor);
  const statusOf = (feed: FeedSummary | null): FeedStatus | null =>
    feed && {
      since: formatInstantDate(feed.createdAt, timezone),
      lastUsed: feed.lastUsedAt ? formatInstantDate(feed.lastUsedAt, timezone) : null,
    };

  return (
    <AppPage
      nav={page.nav}
      current="calendar"
      title="Calendar subscriptions"
      description="See time off in Google Calendar, Apple Calendar or Outlook. Each calendar gets a private link: anyone who has it can see that calendar."
    >
      <FeedCard kind="personal" title="Your time off" description="Your approved and pending requests." status={statusOf(feeds.personal)} />
      <FeedCard
        kind="team"
        title="Who's out"
        description="Everyone's approved and pending time off: names, dates and leave types, never notes."
        status={statusOf(feeds.team)}
      />

      <Section title="Adding a link" size="sm" className="space-y-2 text-sm text-muted">
        <ul className="space-y-1">
          <li>Google Calendar: Other calendars, then +, then From URL.</li>
          <li>Apple Calendar: File, then New Calendar Subscription.</li>
          <li>Outlook: Add calendar, then Subscribe from web.</li>
        </ul>
        <p>Google checks for changes on its own schedule, which can take up to a day.</p>
      </Section>
    </AppPage>
  );
}
