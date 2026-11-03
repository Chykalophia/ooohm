import { formatLeaveDates } from "@/lib/format";
import { InlineAction } from "@/components/forms/inline-action";
import { cancelLeaveAction } from "@/app/actions";

/**
 * What cancelling a request asks first: approved time off gives its days back; someone
 * else who approves the person's requests is emailed (nobody is for a self-approver).
 */
export function cancelQuestion(r: { status: string; approverId: string | null }, me: string): string {
  const told = r.approverId && r.approverId !== me ? " Your approver is told." : "";
  return r.status === "approved" ? `Cancel this time off? The days go back to your balance.${told}` : `Cancel this request?${told}`;
}

/**
 * "Cancel request" for one of the person's own requests, wherever it is shown (the
 * dashboard, "Your requests", the request's own page). It asks first, so approved time
 * off is never dropped by a stray click, and is drawn in the removing-action red.
 *
 * @param focusOnSuccess The element (with `tabIndex={-1}`) focus moves to once the
 *   request is cancelled: this action disappears with it.
 */
export function CancelRequest({
  request: r,
  me,
  focusOnSuccess,
}: {
  request: { id: string; startDate: string; endDate: string; dayPortion: "full" | "am" | "pm"; status: string; approverId: string | null };
  me: string;
  focusOnSuccess: string;
}) {
  return (
    <InlineAction
      action={cancelLeaveAction}
      fields={{ requestId: r.id }}
      label="Cancel request"
      variant="danger"
      ariaLabel={`Cancel the request for ${formatLeaveDates(r.startDate, r.endDate, r.dayPortion)}`}
      pendingLabel="Cancelling…"
      confirm={cancelQuestion(r, me)}
      confirmLabel="Yes, cancel it"
      confirmVariant="danger"
      showSuccess={false}
      focusOnSuccess={focusOnSuccess}
    />
  );
}
