import { canAdminister } from "@/domain/admin-permissions";
import type { Metadata } from "next";
import Link from "next/link";
import { describeOverlap } from "@/domain/overlap";
import { requireActor } from "@/lib/auth";
import { formatDays, formatInstantDate, formatLeaveDates } from "@/lib/format";
import { serviceContext } from "@/server/runtime";
import { getApprovalTriage, type TriageItem } from "@/server/services/approvals";
import { AppHeader } from "@/app/app-header";
import { NoCompany } from "@/app/no-company";
import { StatusBadge } from "@/app/status-badge";
import { DecisionForm } from "./decision-form";

export const metadata: Metadata = { title: "Approvals · OOOhm" };

const VIEWS = ["needs-you", "waiting", "settled"] as const;
type View = (typeof VIEWS)[number];

function readView(value: string | string[] | undefined): View {
  return VIEWS.find((v) => v === value) ?? "needs-you";
}

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, actor } = await requireActor();
  const userName = user.name || user.email;

  if (!actor) return <NoCompany userName={userName} current="approvals" />;

  const [triage, params] = await Promise.all([getApprovalTriage(serviceContext(), actor), searchParams]);
  const { needsYou, waiting, settled, total, shown } = triage;
  // Waiting on others only exists for admins; a link to an empty tab would only add noise.
  const view = readView(params.view) === "waiting" && waiting.length === 0 ? "needs-you" : readView(params.view);

  const tabs: { view: View; label: string; count?: number }[] = [
    { view: "needs-you", label: "Needs you", count: needsYou.length },
    ...(waiting.length > 0 ? [{ view: "waiting" as const, label: "Waiting on others", count: waiting.length }] : []),
    { view: "settled", label: "Settled" },
  ];

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
      {/* Keep the link visible while here, even when the last request was just decided. */}
      <AppHeader userName={userName} approvals={{ visible: true, pending: total }} current="approvals" admin={canAdminister(actor)} />

      <main className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>

        <nav aria-label="Approvals" className="flex flex-wrap gap-x-6 gap-y-2 border-b border-border">
          {tabs.map((t) => (
            <Link
              key={t.view}
              href={t.view === "needs-you" ? "/approvals" : `/approvals?view=${t.view}`}
              aria-current={view === t.view ? "page" : undefined}
              className="-mb-px inline-flex items-center gap-2 border-b-2 border-transparent pb-2 text-sm font-medium text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink aria-[current=page]:border-accent aria-[current=page]:text-foreground"
            >
              {t.label}
              {t.count !== undefined && t.count > 0 && (
                <span className="rounded-full bg-accent/10 px-2 text-xs text-accent-ink tabular-nums">{t.count}</span>
              )}
            </Link>
          ))}
        </nav>

        {view === "needs-you" && (
          <PendingList
            items={needsYou}
            actorId={actor.id}
            empty={
              waiting.length > 0
                ? `Nothing needs you right now. ${waiting.length === 1 ? "One request is" : `${waiting.length} requests are`} waiting on someone else.`
                : "Nothing needs you right now."
            }
            cut={total > shown ? `Showing the first ${shown} of ${total}, earliest dates first. Decide these to see the rest.` : null}
          />
        )}
        {view === "waiting" && (
          <>
            <p className="text-sm text-muted">Assigned to someone else. As an admin you can still decide them.</p>
            <PendingList items={waiting} actorId={actor.id} empty="Nothing is waiting on anyone else." cut={null} />
          </>
        )}
        {view === "settled" &&
          (settled.length === 0 ? (
            <p className="text-muted">You haven’t decided anything in the last {triage.settledDays} days.</p>
          ) : (
            <>
              <p className="text-sm text-muted">What you decided in the last {triage.settledDays} days, newest first.</p>
              <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
                {settled.map((d) => (
                  <li key={`${d.id}-${d.decidedAt.toISOString()}`} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium break-words">{d.requesterName || d.requesterEmail}</p>
                      <p className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: d.leaveTypeColor }} aria-hidden />
                        {formatLeaveDates(d.startDate, d.endDate, d.dayPortion)}
                      </p>
                      <p className="text-sm text-muted">
                        {d.leaveTypeName} · {formatDays(d.days)} · {d.decision === "approved" ? "Approved" : "Declined"} by you on{" "}
                        {formatInstantDate(d.decidedAt, triage.timeZone)}
                      </p>
                      {d.decisionNote && (
                        <p className="text-sm break-words">
                          <span className="text-muted">Your note: </span>
                          {d.decisionNote}
                        </p>
                      )}
                    </div>
                    <div className="shrink-0">
                      <StatusBadge status={d.status} />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ))}
      </main>
    </div>
  );
}

function PendingList({ items, actorId, empty, cut }: { items: TriageItem[]; actorId: string; empty: string; cut: string | null }) {
  if (items.length === 0) return <p className="text-muted">{empty}</p>;
  return (
    <>
      {cut && <p className="text-sm text-muted">{cut}</p>}
      <ul className="space-y-4">
        {items.map((r) => (
          <li key={r.id} className="space-y-4 rounded-2xl border border-border bg-surface p-5">
            <div className="space-y-1">
              <p className="font-medium break-words">
                {r.requesterName || r.requesterEmail}
                {r.requesterName && <span className="ml-2 text-sm font-normal text-muted">{r.requesterEmail}</span>}
              </p>
              <p className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: r.leaveTypeColor }} aria-hidden />
                {formatLeaveDates(r.startDate, r.endDate, r.dayPortion)}
              </p>
              <p className="text-sm text-muted">
                {r.leaveTypeName} · {formatDays(r.days)}
                {r.approverId && r.approverId !== actorId && ` · Assigned to ${r.approverName || "someone else"}`}
              </p>
              {r.note && <p className="text-sm break-words">{r.note}</p>}
              <p className={`text-sm break-words ${r.overlaps.length > 0 ? "font-medium" : "text-muted"}`}>
                {describeOverlap(r.overlaps, r.requesterDepartmentId ? r.requesterDepartmentName : null)}
              </p>
            </div>
            <DecisionForm requestId={r.id} />
          </li>
        ))}
      </ul>
    </>
  );
}
