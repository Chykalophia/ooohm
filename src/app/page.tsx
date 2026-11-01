import { isCancellable } from "@/domain/request-status";
import { requireActor } from "@/lib/auth";
import { formatDays, formatLeaveDates } from "@/lib/format";
import { serviceContext } from "@/server/runtime";
import { getApprovalNav } from "@/server/services/approvals";
import { getDashboard } from "@/server/services/leave-requests";
import { AppHeader } from "./app-header";
import { CancelRequestButton } from "./cancel-request-button";
import { RequestLeaveForm } from "./request-leave-form";
import { StatusBadge } from "./status-badge";

const REQUESTS_HEADING_ID = "mine-heading";

export default async function HomePage() {
  const { user, actor } = await requireActor();
  const userName = user.name || user.email;

  if (!actor) {
    return (
      <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
        <AppHeader userName={userName} approvals={null} current="home" />
        <main>
          <p className="text-muted">Your account isn&apos;t part of a company yet. Ask an admin to finish setting it up.</p>
        </main>
      </div>
    );
  }

  const ctx = serviceContext();
  const [dashboard, approvals] = await Promise.all([getDashboard(ctx, actor), getApprovalNav(ctx, actor)]);

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
      <AppHeader userName={userName} approvals={approvals} current="home" />

      <main className="space-y-10">
        <h1 className="sr-only">Your time off</h1>
        {dashboard.leaveTypes.length === 0 ? (
          <p className="text-muted">No leave types yet. An admin needs to set them up.</p>
        ) : (
          <RequestLeaveForm leaveTypes={dashboard.leaveTypes} defaultDate={dashboard.defaultDate} />
        )}

        <section aria-labelledby={REQUESTS_HEADING_ID} className="space-y-4">
          {/* Focus lands here after a cancel, when the cancel button itself disappears. */}
          <h2 id={REQUESTS_HEADING_ID} tabIndex={-1} className="text-lg font-semibold tracking-tight outline-none">
            Your requests
          </h2>
          {dashboard.requests.length === 0 ? (
            <p className="text-muted">Nothing yet. Your requests will show up here.</p>
          ) : (
            <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
              {dashboard.requests.map((r) => (
                <li key={r.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <p className="flex items-center gap-2 font-medium">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: r.leaveTypeColor }} aria-hidden />
                      {formatLeaveDates(r.startDate, r.endDate, r.dayPortion)}
                    </p>
                    <p className="text-sm text-muted">
                      {r.leaveTypeName} · {formatDays(r.days)}
                      {r.status === "pending" && r.approverName && r.approverId !== actor.id && ` · with ${r.approverName}`}
                    </p>
                    {r.note && <p className="text-sm text-muted break-words">{r.note}</p>}
                    {r.decisionNote && (
                      <p className="text-sm break-words">
                        <span className="text-muted">{r.status === "rejected" ? "Reason: " : "Note from approver: "}</span>
                        {r.decisionNote}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                    <StatusBadge status={r.status} />
                    {isCancellable(r.status) && <CancelRequestButton requestId={r.id} focusAfterCancel={REQUESTS_HEADING_ID} />}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
