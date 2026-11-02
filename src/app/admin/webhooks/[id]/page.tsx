import type { Metadata } from "next";
import Link from "next/link";
import { MAX_DELIVERY_ATTEMPTS } from "@/domain/integrations";
import { formatCount, formatInstantDateTime } from "@/lib/format";
import { getWebhookEndpoint } from "@/server/services/webhooks";
import { AdminShell } from "@/app/admin/admin-shell";
import { orNotFound, requireAdminPage } from "@/app/_lib/page-context";
import { Section } from "@/components/ui/section";
import { Item, ItemList } from "@/components/ui/card";
import { ActionForm } from "@/components/forms/action-form";
import { InlineAction } from "@/components/forms/inline-action";
import { Reveal } from "@/components/forms/reveal";
import { RevealForm } from "@/components/forms/reveal-form";
import { outlineButton, primaryButton, textLink } from "@/components/ui/styles";
import {
  deleteEndpointAction,
  redeliverAction,
  rotateSecretAction,
  sendPingAction,
  setEndpointEnabledAction,
  updateEndpointAction,
} from "@/app/admin/webhooks/actions";
import { DeliveryStatusText } from "@/app/admin/webhooks/delivery-status";
import { EndpointFields } from "@/app/admin/webhooks/endpoint-fields";

export const metadata: Metadata = { title: "Endpoint · Webhooks · Admin · OOOhm" };

export default async function WebhookEndpointPage({ params }: { params: Promise<{ id: string }> }) {
  const { actor, ctx, nav } = await requireAdminPage();
  const { id } = await params;
  const { endpoint, deliveries, timezone } = await orNotFound(getWebhookEndpoint(ctx, actor, id));
  const at = (d: Date) => formatInstantDateTime(d, timezone);

  return (
    <AdminShell
      nav={nav}
      section="webhooks"
      title={new URL(endpoint.url).host}
      description={
        <>
          <span className="break-all">{endpoint.url}</span>
          {endpoint.description && <span className="block break-words">{endpoint.description}</span>}
        </>
      }
      action={
        endpoint.enabled ? (
          <InlineAction key="ping" action={sendPingAction} fields={{ id: endpoint.id }} label="Send test event" pendingLabel="Queuing…" className={primaryButton} />
        ) : undefined
      }
    >
      <p className="text-sm">
        <Link href="/admin/webhooks" className={textLink}>
          ← All endpoints
        </Link>
      </p>

      <Section title={endpoint.enabled ? "On" : "Off"} surface>
        <p className="text-sm text-muted">
          {endpoint.enabled
            ? `Sends ${formatCount(endpoint.eventTypes.length, "kind of event", "kinds of events")}. Added ${at(endpoint.createdAt)}.`
            : "Nothing new is queued for it, and queued deliveries wait until you turn it back on."}
        </p>
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <InlineAction
            key={endpoint.enabled ? "off" : "on"}
            action={setEndpointEnabledAction}
            fields={{ id: endpoint.id, enabled: String(!endpoint.enabled) }}
            label={endpoint.enabled ? "Turn off" : "Turn on"}
            pendingLabel="Saving…"
            className={outlineButton}
            focusResult
          />
          <Reveal label="Edit" ariaLabel="Edit the endpoint">
            <ActionForm action={updateEndpointAction} submitLabel="Save changes" pendingLabel="Saving…" buttonClassName={outlineButton}>
              <input type="hidden" name="id" value={endpoint.id} />
              <EndpointFields endpoint={endpoint} />
            </ActionForm>
          </Reveal>
        </div>
      </Section>

      <Section title="Signing secret" surface className="space-y-3">
        <p className="text-sm text-muted">
          OOOhm keeps it encrypted and never shows it again. If it was lost or leaked, get a new one: deliveries from then on,
          retries included, are signed with the new secret only.
        </p>
        <RevealForm
          action={rotateSecretAction}
          submitLabel="Get a new secret"
          pendingLabel="Rotating…"
          valueLabel="New signing secret"
          note="Update the receiving app now. It won't be shown again."
          confirm="The current secret stops working at once, so the receiving app will reject deliveries until it has the new one."
          confirmLabel="Yes, get a new secret"
          buttonClassName={outlineButton}
          className="space-y-3"
        >
          <input type="hidden" name="id" value={endpoint.id} />
        </RevealForm>
      </Section>

      <Section title="Recent deliveries" className="space-y-3">
        {deliveries.length === 0 ? (
          <p className="text-muted">Nothing sent yet. Send a test event to try it.</p>
        ) : (
          <ItemList>
            {deliveries.map((d) => {
              const retrying = d.status === "pending" && d.attempts > 0 && d.lastError !== null;
              const result =
                d.lastStatusCode !== null
                  ? `HTTP ${d.lastStatusCode}${d.lastLatencyMs !== null ? ` in ${d.lastLatencyMs} ms` : ""}`
                  : d.lastError;
              return (
                <Item key={d.id} className="space-y-1.5 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <code className="font-mono">{d.eventType}</code>
                    <DeliveryStatusText status={d.status} retrying={retrying} />
                  </div>
                  <p className="text-muted">
                    {at(d.createdAt)}
                    {d.attempts > 0 && ` · ${formatCount(d.attempts, "attempt", "attempts")} of ${MAX_DELIVERY_ATTEMPTS}`}
                    {result && ` · ${result}`}
                    {d.status === "pending" && d.attempts > 0 && d.lastError !== null && ` · next try ${at(d.nextAttemptAt)}`}
                  </p>
                  {d.status !== "pending" && d.status !== "cancelled" && endpoint.enabled && (
                    <InlineAction
                      action={redeliverAction}
                      fields={{ endpointId: endpoint.id, deliveryId: d.id }}
                      label="Send again"
                      ariaLabel={`Send ${d.eventType} again`}
                      pendingLabel="Queuing…"
                    />
                  )}
                </Item>
              );
            })}
          </ItemList>
        )}
      </Section>

      <Section title="Delete this endpoint" size="sm" className="space-y-2">
        <p className="text-sm text-muted">It gets nothing more, and anything still queued for it is cancelled.</p>
        <InlineAction
          action={deleteEndpointAction}
          fields={{ id: endpoint.id }}
          label="Delete"
          pendingLabel="Deleting…"
          danger
          confirm={`Delete the endpoint at ${new URL(endpoint.url).host}?`}
          confirmLabel="Yes, delete"
        />
      </Section>
    </AdminShell>
  );
}
