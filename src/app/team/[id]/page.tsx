import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";
import { formatDays, formatLeaveDates } from "@/lib/format";
import { getTeamMember } from "@/server/services/team-member";
import { AppPage } from "@/components/layout/app-page";
import { NoCompany } from "@/components/layout/no-company";
import { BalanceSummary } from "@/components/leave/balance-summary";
import { StatusBadge } from "@/components/leave/status-badge";
import { ItemList, Item } from "@/components/ui/card";
import { ColorLabel } from "@/components/ui/color-label";
import { BackLink, Section } from "@/components/ui/section";
import { textLink } from "@/components/ui/styles";
import { RequestLeaveForm } from "@/app/request-leave-form";
import { orNotFound, requireMemberPage } from "@/app/_lib/page-context";

/** The teammate, loaded once per request for both the tab title and the page. */
const loadMember = cache(async (id: string) => {
  const page = await requireMemberPage();
  return { page, member: page.actor ? await getTeamMember(page.ctx, page.actor, id) : null };
});

/** The tab names the teammate (WCAG 2.4.2); if they can't be loaded, the page itself answers. */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  try {
    const { member } = await loadMember((await params).id);
    return { title: member ? `${member.person.name} · Team · OOOhm` : "Team · OOOhm" };
  } catch {
    return { title: "Team · OOOhm" };
  }
}

type Member = Awaited<ReturnType<typeof getTeamMember>>;
type Entry = Member["upcoming"][number];

/**
 * One teammate, opened from Team. Everyone sees what the team calendar shows: who they
 * are and their leave around now. The person, admins and (when the company allows it)
 * their manager also see their balances and the notes on their requests. Admins and
 * their direct manager can add time off for them, approved as it is added.
 */
export default async function TeamMemberPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { page, member } = await orNotFound(loadMember(id));
  if (!member) return <NoCompany nav={page.nav} current="team" />;
  const { person } = member;
  const about = [person.departmentName, person.managerName && `Reports to ${person.managerName}`].filter(Boolean).join(" · ");

  return (
    <AppPage nav={page.nav} current="team" title={person.name} description={about || undefined}>
      <BackLink href="/team">← Who&apos;s out</BackLink>

      {person.isMe && (
        <p className="text-sm text-muted">
          This is you. Your teammates see when you&apos;re off, not your notes or balances. All your requests are on{" "}
          <Link href="/requests" className={textLink}>
            Your requests
          </Link>
          .
        </p>
      )}

      <Section title="Coming up">
        {member.upcoming.length === 0 ? <p className="text-muted">Nothing planned.</p> : <LeaveList entries={member.upcoming} />}
      </Section>

      {member.recent.length > 0 && (
        <Section title={`In the last ${member.recentDays} days`}>
          <LeaveList entries={member.recent} />
        </Section>
      )}

      {member.addLeave && member.addLeave.leaveTypes.length > 0 && (
        <RequestLeaveForm
          leaveTypes={member.addLeave.leaveTypes}
          defaultDate={member.addLeave.defaultDate}
          forPerson={{ id: person.id, name: person.name }}
        />
      )}

      {member.balances && <BalanceSummary summary={member.balances} title={`Balance for ${member.balances.year}`} />}
    </AppPage>
  );
}

/** Leave as the team calendar shows it, plus the days and notes for those allowed to see them. */
function LeaveList({ entries }: { entries: readonly Entry[] }) {
  return (
    <ItemList>
      {entries.map((e) => (
        <Item key={e.id} className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <ColorLabel color={e.leaveTypeColor} className="font-medium">
              {formatLeaveDates(e.startDate, e.endDate, e.dayPortion)}
            </ColorLabel>
            <p className="text-sm text-muted">
              {e.leaveTypeName}
              {e.details && ` · ${formatDays(e.details.days)}`}
            </p>
            {e.details?.note && <p className="text-sm break-words text-muted">{e.details.note}</p>}
            {e.details?.decisionNote && (
              <p className="text-sm break-words">
                <span className="text-muted">Note from approver: </span>
                {e.details.decisionNote}
              </p>
            )}
          </div>
          {e.status === "pending" && <StatusBadge status="pending" />}
        </Item>
      ))}
    </ItemList>
  );
}
