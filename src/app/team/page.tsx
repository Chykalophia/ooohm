import type { Metadata } from "next";
import Link from "next/link";
import { requireActor } from "@/lib/auth";
import { normalizeHexColor } from "@/lib/color";
import { formatLeaveDates, formatMonth } from "@/lib/format";
import { serviceContext } from "@/server/runtime";
import { getApprovalNav } from "@/server/services/approvals";
import { getTeamCalendar } from "@/server/services/calendar";
import { AppHeader } from "@/app/app-header";
import { departmentParamSchema, monthParamSchema, readParam } from "@/app/calendar-input";
import { MonthNav } from "@/app/month-nav";
import { NoCompany } from "@/app/no-company";
import { StatusBadge } from "@/app/status-badge";

export const metadata: Metadata = { title: "Team · OOOhm" };

const HEADING_ID = "team-month-heading";
const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

function teamHref(month: string, departmentId: string | null): string {
  const query = new URLSearchParams({ month });
  if (departmentId) query.set("department", departmentId);
  return `/team?${query}`;
}

export default async function TeamPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, actor } = await requireActor();
  const userName = user.name || user.email;
  if (!actor) return <NoCompany userName={userName} current="team" />;

  const params = await searchParams;
  const ctx = serviceContext();
  const [team, approvals] = await Promise.all([
    getTeamCalendar(ctx, actor, {
      month: readParam(monthParamSchema, params.month),
      departmentId: readParam(departmentParamSchema, params.department),
    }),
    getApprovalNav(ctx, actor),
  ]);
  const { nav, departments, department, people } = team;
  const departmentId = department?.id ?? null;

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
      <AppHeader userName={userName} approvals={approvals} current="team" />

      <main className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Who&apos;s out</h1>

        <section aria-labelledby={HEADING_ID} className="space-y-6">
          <MonthNav nav={nav} href={(m) => teamHref(m, departmentId)} headingId={HEADING_ID} />

          {departments.length > 0 && (
            <nav aria-label="Departments" className="flex flex-wrap gap-2 text-sm">
              {[{ id: null, name: "Everyone" }, ...departments].map((d) => {
                const active = d.id === departmentId;
                return (
                  <Link
                    key={d.id ?? "everyone"}
                    href={teamHref(nav.month, d.id)}
                    aria-current={active ? "page" : undefined}
                    className={`rounded-full border px-3 py-1 ${focusRing} ${
                      active ? "border-accent text-accent" : "border-border text-muted hover:text-foreground"
                    }`}
                  >
                    {d.name}
                  </Link>
                );
              })}
            </nav>
          )}

          {people.length === 0 ? (
            <p className="text-muted">
              Nobody{department ? ` in ${department.name}` : ""} is out in {formatMonth(nav.month)}.
            </p>
          ) : (
            <ul className="space-y-4">
              {people.map((person) => (
                <li key={person.userId} className="space-y-3 rounded-2xl border border-border bg-surface p-5">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <h3 className="font-medium break-words">{person.personName}</h3>
                    {person.departmentName && !department && <p className="text-sm text-muted">{person.departmentName}</p>}
                  </div>
                  <ul className="space-y-2">
                    {person.entries.map((entry) => (
                      <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: normalizeHexColor(entry.leaveTypeColor) }}
                            aria-hidden
                          />
                          <span>
                            {formatLeaveDates(entry.startDate, entry.endDate, entry.dayPortion)}
                            <span className="text-muted"> · {entry.leaveTypeName}</span>
                          </span>
                        </span>
                        {entry.status === "pending" && <StatusBadge status="pending" />}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="text-sm text-muted">
          <Link
            href="/calendar/subscriptions"
            className={`rounded-md underline-offset-4 hover:text-foreground hover:underline ${focusRing}`}
          >
            Add who&apos;s out to your calendar app
          </Link>
        </p>
      </main>
    </div>
  );
}
