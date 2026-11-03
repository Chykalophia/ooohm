import type { Metadata } from "next";
import Link from "next/link";
import { API_GUIDE_URL } from "@/domain/integrations";
import { formatInstantDateTime } from "@/lib/format";
import { listWebhookEndpoints } from "@/server/services/webhooks";
import { AdminShell, requireAdminPage } from "@/app/admin/admin-shell";
import { primaryButton, textLink } from "@/app/styles";
import { DeliveryStatusText } from "@/app/admin/webhooks/delivery-status";

export const metadata: Metadata = { title: "Webhooks · Admin · OOOhm" };

export default async function WebhooksPage() {
  const { actor, ctx, userName, approvals } = await requireAdminPage();
  const { endpoints, timezone } = await listWebhookEndpoints(ctx, actor);

  return (
    <AdminShell
      userName={userName}
      approvals={approvals}
      section="webhooks"
      title="Webhooks"
      description="When something changes in OOOhm, it sends a signed POST to each endpoint that wants that event, and retries for about two days if the endpoint is down."
      action={
        <Link href="/admin/webhooks/new" className={primaryButton}>
          Add endpoint
        </Link>
      }
    >
      {endpoints.length === 0 ? (
        <p className="text-muted">No endpoints yet. Add one to send leave and people events to another app.</p>
      ) : (
        <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
          {endpoints.map((e) => (
            <li key={e.id} className="space-y-2 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Link href={`/admin/webhooks/${e.id}`} className={`${textLink} font-medium break-all`}>
                  {e.url}
                </Link>
                <span className={`text-sm ${e.enabled ? "text-accent-ink" : "text-muted"}`}>{e.enabled ? "On" : "Off"}</span>
              </div>
              {e.description && <p className="text-sm break-words">{e.description}</p>}
              <p className="text-sm text-muted">
                {e.eventTypes.length === 1 ? "1 event" : `${e.eventTypes.length} events`}
                {" · "}
                {e.latest ? (
                  <>
                    Last delivery <DeliveryStatusText status={e.latest.status} /> {formatInstantDateTime(e.latest.at, timezone)}
                  </>
                ) : (
                  "Nothing sent yet"
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm text-muted">
        Each request carries <code className="font-mono">OOOhm-Signature</code>, an HMAC of its timestamp and body with the
        endpoint&apos;s secret; the{" "}
        <a href={API_GUIDE_URL} className={textLink} target="_blank" rel="noreferrer">
          API guide
        </a>{" "}
        shows how to check it. The REST API is described at{" "}
        <a href="/api/v1/openapi.json" className={textLink}>
          /api/v1/openapi.json
        </a>
        .
      </p>
    </AdminShell>
  );
}
