import type { Metadata } from "next";
import Link from "next/link";
import { endpointSummary, getWebhookEndpoint, presentDelivery } from "@/modules/integrations";
import { unwrap } from "@/shared/lib/result";
import { AdminShell } from "@/app/admin/admin-shell";
import { orNotFound, requireAdminPage } from "@/app/_lib/page-context";
import { pagerLinks, readPageParams } from "@/app/_lib/paging";
import { Pager } from "@/components/navigation/pager";
import { Section } from "@/components/ui/section";
import { ActionForm } from "@/components/forms/action-form";
import { InlineAction } from "@/components/forms/inline-action";
import { Reveal } from "@/components/forms/reveal";
import { RevealForm } from "@/components/forms/reveal-form";
import { outlineButton, textLink } from "@/components/ui/styles";
import { deleteEndpointAction, rotateSecretAction, sendPingAction, setEndpointEnabledAction, updateEndpointAction } from "./actions";
import { DeliveryList } from "./delivery-list";
import { EndpointFields } from "@/app/admin/webhooks/endpoint-fields";

export const metadata: Metadata = { title: "Endpoint · Webhooks · Admin · OOOhm" };

const DELIVERIES_ID = "deliveries";

export default async function WebhookEndpointPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { actor, ctx, nav } = await requireAdminPage();
  const { id } = await params;
  const { cursor, number } = readPageParams(await searchParams);
  const { endpoint, deliveries, deliveryPages, timezone } = await orNotFound(getWebhookEndpoint(ctx, actor, id, cursor).then(unwrap));
  const pager = pagerLinks(`/admin/webhooks/${endpoint.id}`, deliveryPages, number, { fragment: DELIVERIES_ID });

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
          <InlineAction key="ping" action={sendPingAction} fields={{ id: endpoint.id }} label="Send test event" pendingLabel="Queuing…" variant="primary" />
        ) : undefined
      }
    >
      <p className="text-sm">
        <Link href="/admin/webhooks" className={textLink}>
          ← All endpoints
        </Link>
      </p>

      <Section title={endpoint.enabled ? "On" : "Off"} surface>
        <p className="text-sm text-muted">{endpointSummary(endpoint, timezone)}</p>
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <InlineAction
            key={endpoint.enabled ? "off" : "on"}
            action={setEndpointEnabledAction}
            fields={{ id: endpoint.id, enabled: String(!endpoint.enabled) }}
            label={endpoint.enabled ? "Turn off" : "Turn on"}
            pendingLabel="Saving…"
            variant="outline"
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

      <Section id={DELIVERIES_ID} title="Deliveries" className="scroll-mt-6 space-y-3">
        <DeliveryList
          endpointId={endpoint.id}
          deliveries={deliveries.map((d) => presentDelivery(d, timezone, endpoint.enabled))}
          empty={deliveryPages.previous ? "No older deliveries." : "Nothing sent yet. Send a test event to try it."}
        />
        <Pager label="Delivery pages" links={pager} />
      </Section>

      <Section title="Delete this endpoint" size="sm" className="space-y-2">
        <p className="text-sm text-muted">It gets nothing more, and anything still queued for it is cancelled.</p>
        <InlineAction
          action={deleteEndpointAction}
          fields={{ id: endpoint.id }}
          label="Delete"
          pendingLabel="Deleting…"
          variant="danger"
          confirm={`Delete the endpoint at ${new URL(endpoint.url).host}?`}
          confirmLabel="Yes, delete"
        />
      </Section>
    </AdminShell>
  );
}
