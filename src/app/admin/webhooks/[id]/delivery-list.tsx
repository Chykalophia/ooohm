import type { WebhookDeliveryView } from "@/modules/integrations";
import { InlineAction } from "@/components/forms/inline-action";
import { Item, ItemList } from "@/components/ui/card";
import { DeliveryStatusText } from "@/app/admin/webhooks/delivery-status";
import { redeliverAction } from "./actions";

/** An endpoint's deliveries, newest first, each with its outcome and, once finished, "Send again". */
export function DeliveryList({ endpointId, deliveries, empty }: { endpointId: string; deliveries: WebhookDeliveryView[]; empty: string }) {
  if (deliveries.length === 0) return <p className="text-muted">{empty}</p>;
  return (
    <ItemList>
      {deliveries.map((d) => (
        <Item key={d.id} className="space-y-1.5 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <code className="font-mono">{d.eventType}</code>
            <DeliveryStatusText status={d.status} retrying={d.retrying} />
          </div>
          <p className="text-muted">{d.detail}</p>
          {d.canRedeliver && (
            <InlineAction
              action={redeliverAction}
              fields={{ endpointId, deliveryId: d.id }}
              label="Send again"
              ariaLabel={`Send ${d.eventType} again`}
              pendingLabel="Queuing…"
            />
          )}
        </Item>
      ))}
    </ItemList>
  );
}
