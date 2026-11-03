import { RequestCard, type RequestCardData } from "@/components/leave/request-card";
import { CancelRequest } from "./cancel-request";

/**
 * The person's own requests as cards, each opening its own page and, while it can be
 * cancelled, offering Cancel request. Used by the dashboard (the latest few) and by
 * "Your requests" (all of them, a page at a time).
 *
 * @param focusAfterCancel Where focus goes once a request is cancelled (its Cancel button
 *   goes with it): the list's heading.
 */
export function RequestList({
  requests,
  me,
  focusAfterCancel,
}: {
  requests: readonly (RequestCardData & { cancellable: boolean })[];
  me: string;
  focusAfterCancel: string;
}) {
  return (
    <ul className="space-y-3">
      {requests.map((r) => (
        <RequestCard
          key={r.id}
          request={r}
          me={me}
          href={`/requests/${r.id}`}
          action={r.cancellable ? <CancelRequest request={r} me={me} focusOnSuccess={focusAfterCancel} /> : undefined}
        />
      ))}
    </ul>
  );
}
