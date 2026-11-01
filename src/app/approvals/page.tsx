import type { Metadata } from "next";
import { requireActor } from "@/lib/auth";
import { formatDays, formatLeaveDates } from "@/lib/format";
import { serviceContext } from "@/server/runtime";
import { listApprovalInbox } from "@/server/services/approvals";
import { AppHeader } from "@/app/app-header";
import { NoCompany } from "@/app/no-company";
import { DecisionForm } from "./decision-form";

export const metadata: Metadata = { title: "Approvals · OOOhm" };

export default async function ApprovalsPage() {
  const { user, actor } = await requireActor();
  const userName = user.name || user.email;

  if (!actor) return <NoCompany userName={userName} current="approvals" />;

  const { items, total } = await listApprovalInbox(serviceContext(), actor);

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
      {/* Keep the link visible while here, even when the last request was just decided. */}
      <AppHeader userName={userName} approvals={{ visible: true, pending: total }} current="approvals" />

      <main className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
        {items.length === 0 ? (
          <p className="text-muted">Nothing is waiting for you.</p>
        ) : (
          <>
            {total > items.length && (
              <p className="text-sm text-muted">
                Showing the first {items.length} of {total}, earliest dates first. Decide these to see the rest.
              </p>
            )}
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
                      {r.approverId !== actor.id && ` · Assigned to ${r.approverName || "someone else"}`}
                    </p>
                    {r.note && <p className="text-sm break-words">{r.note}</p>}
                  </div>
                  <DecisionForm requestId={r.id} />
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    </div>
  );
}
