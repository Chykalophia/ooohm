import type { Metadata } from "next";
import Link from "next/link";
import { formatLeaveDates, formatMonth } from "@/lib/format";
import { getTeamCalendar } from "@/server/services/calendar";
import { AppPage } from "@/components/layout/app-page";
import { NoCompany } from "@/components/layout/no-company";
import { StatusBadge } from "@/components/leave/status-badge";
import { MonthNav } from "@/components/navigation/month-nav";
import { PillNav } from "@/components/navigation/pill-nav";
import { Card } from "@/components/ui/card";
import { ColorLabel } from "@/components/ui/color-label";
import { cx, quietLink, textLink } from "@/components/ui/styles";
import { departmentParamSchema, monthParamSchema, readParam } from "@/app/_lib/calendar-input";
import { requireMemberPage } from "@/app/_lib/page-context";

export const metadata: Metadata = { title: "Team · OOOhm" };

const HEADING_ID = "team-month-heading";

function teamHref(month: string, departmentId: string | null): string {
  const query = new URLSearchParams({ month });
  if (departmentId) query.set("department", departmentId);
  return `/team?${query}`;
}

export default async function TeamPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const page = await requireMemberPage();
  if (!page.actor) return <NoCompany nav={page.nav} current="team" />;

  const params = await searchParams;
  const { nav, departments, department, people } = await getTeamCalendar(page.ctx, page.actor, {
    month: readParam(monthParamSchema, params.month),
    departmentId: readParam(departmentParamSchema, params.department),
  });
  const departmentId = department?.id ?? null;

  return (
    <AppPage nav={page.nav} current="team" title="Who's out">
      <section aria-labelledby={HEADING_ID} className="space-y-6">
        <MonthNav nav={nav} href={(m) => teamHref(m, departmentId)} headingId={HEADING_ID} />

        {departments.length > 0 && (
          <PillNav
            label="Departments"
            items={[{ id: null, name: "Everyone" }, ...departments].map((d) => ({
              href: teamHref(nav.month, d.id),
              label: d.name,
              current: d.id === departmentId ? "page" : undefined,
            }))}
          />
        )}

        {people.length === 0 ? (
          <p className="text-muted">
            Nobody{department ? ` in ${department.name}` : ""} is out in {formatMonth(nav.month)}.
          </p>
        ) : (
          <ul className="space-y-4">
            {people.map((person) => (
              <Card as="li" key={person.userId} className="space-y-3">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <h3 className="font-medium break-words">
                    <Link href={`/team/${person.userId}`} className={cx(textLink, "hover:text-accent-ink")}>
                      {person.personName}
                    </Link>
                  </h3>
                  {person.departmentName && !department && <p className="text-sm text-muted">{person.departmentName}</p>}
                </div>
                <ul className="space-y-2">
                  {person.entries.map((entry) => (
                    <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2">
                      <ColorLabel color={entry.leaveTypeColor} as="span" className="min-w-0">
                        <span>
                          {formatLeaveDates(entry.startDate, entry.endDate, entry.dayPortion)}
                          <span className="text-muted"> · {entry.leaveTypeName}</span>
                        </span>
                      </ColorLabel>
                      {entry.status === "pending" && <StatusBadge status="pending" />}
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </ul>
        )}
      </section>

      <p className="text-sm">
        <Link href="/calendar/subscriptions" className={quietLink}>
          Add who&apos;s out to your calendar app
        </Link>
      </p>
    </AppPage>
  );
}
