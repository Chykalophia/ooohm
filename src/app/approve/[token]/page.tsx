import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { formatDays, formatLeaveDates } from "@/lib/format";
import { serviceContext } from "@/server/runtime";
import { type EmailApproval, readEmailApproval } from "@/server/services/email-approval";
import { StatusBadge } from "@/app/status-badge";
import { ApproveButton } from "./approve-button";

// The token is a credential in the URL: keep it out of search engines and Referer headers.
export const metadata: Metadata = { title: "Approve time off · OOOhm", robots: { index: false, follow: false }, referrer: "no-referrer" };

const HEADLINES: Record<Exclude<EmailApproval["state"], "ready" | "approved">, string> = {
  invalid: "This link doesn’t work",
  expired: "This link has expired",
  not_yours: "This request isn’t yours to decide any more",
  decided: "This request was already decided",
};

/**
 * Where a request email's Approve link lands. Opening it changes nothing (mail
 * scanners open links too); the Approve button does. Declining needs a reason, so it
 * happens in the app.
 */
export default async function ApproveFromEmailPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const approval = await readEmailApproval(serviceContext(), decodeURIComponent(token));
  const openApp = (
    <Link
      href="/approvals"
      className="rounded-md text-sm text-accent-ink underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink"
    >
      {approval.state === "ready" ? "Decline or look closer in OOOhm" : "Open OOOhm"}
    </Link>
  );

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6 rounded-2xl border border-border bg-surface p-8">
        <Logo className="text-2xl" />
        {approval.state === "ready" || approval.state === "decided" || approval.state === "approved" ? (
          <>
            <div className="space-y-1">
              {approval.state === "decided" && <h1 className="mb-3 text-lg font-semibold tracking-tight">{HEADLINES.decided}</h1>}
              <p className="font-medium break-words">{approval.request.requesterName || approval.request.requesterEmail}</p>
              <p className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: approval.request.leaveTypeColor }} aria-hidden />
                {formatLeaveDates(approval.request.startDate, approval.request.endDate, approval.request.dayPortion)}
              </p>
              <p className="text-sm text-muted">
                {approval.request.leaveTypeName} · {formatDays(approval.request.days)}
              </p>
              {approval.request.note && <p className="text-sm break-words">{approval.request.note}</p>}
            </div>
            {approval.state === "ready" ? <ApproveButton token={decodeURIComponent(token)} /> : <StatusBadge status={approval.request.status} />}
          </>
        ) : (
          <h1 className="text-lg font-semibold tracking-tight">{HEADLINES[approval.state]}</h1>
        )}
        <p>{openApp}</p>
      </div>
    </main>
  );
}
