import type { Metadata } from "next";
import Link from "next/link";
import { formatDays, formatLeaveDates } from "@/lib/format";
import { serviceContext } from "@/server/runtime";
import { type EmailApproval, readEmailApproval } from "@/server/services/email-approval";
import { Logo } from "@/components/layout/logo";
import { StatusBadge } from "@/components/leave/status-badge";
import { Card } from "@/components/ui/card";
import { ColorLabel } from "@/components/ui/color-label";
import { cx, textLink } from "@/components/ui/styles";
import { ApproveButton } from "./approve-button";

// The token is a credential in the URL: keep it out of search engines and Referer headers.
export const metadata: Metadata = { title: "Approve time off · OOOhm", robots: { index: false, follow: false }, referrer: "no-referrer" };

const HEADLINES: Record<Exclude<EmailApproval["state"], "ready" | "approved">, string> = {
  invalid: "This link doesn’t work",
  expired: "This link has expired",
  not_yours: "This request isn’t yours to decide any more",
  decided: "This request is no longer waiting",
};

/**
 * Where a request email's Approve link lands. Opening it changes nothing (mail
 * scanners open links too); the Approve button does. Declining needs a reason, so it
 * happens in the app.
 */
export default async function ApproveFromEmailPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Tokens are base64url, so there is nothing to decode (and a stray `%` must not throw).
  const approval = await readEmailApproval(serviceContext(), token);
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card as="div" padding="lg" className="w-full max-w-sm space-y-6">
        <Logo className="text-2xl" />
        {approval.state === "ready" || approval.state === "decided" || approval.state === "approved" ? (
          <>
            <div className="space-y-1">
              <h1 className="mb-3 text-lg font-semibold tracking-tight">{approval.state === "decided" ? HEADLINES.decided : "Approve time off"}</h1>
              <p className="font-medium break-words">{approval.request.requesterName || approval.request.requesterEmail}</p>
              <ColorLabel color={approval.request.leaveTypeColor}>
                {formatLeaveDates(approval.request.startDate, approval.request.endDate, approval.request.dayPortion)}
              </ColorLabel>
              <p className="text-sm text-muted">
                {approval.request.leaveTypeName} · {formatDays(approval.request.days)}
              </p>
              {approval.request.note && <p className="text-sm break-words">{approval.request.note}</p>}
            </div>
            {approval.state === "ready" ? <ApproveButton token={token} /> : <StatusBadge status={approval.request.status} />}
          </>
        ) : (
          <h1 className="text-lg font-semibold tracking-tight">{HEADLINES[approval.state]}</h1>
        )}
        {approval.state !== "ready" && (
          <p>
            <Link href="/approvals" className={cx(textLink, "text-sm text-accent-ink")}>
              Open OOOhm
            </Link>
          </p>
        )}
      </Card>
    </main>
  );
}
