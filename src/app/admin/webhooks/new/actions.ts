"use server";

import { map } from "@/shared/lib/result";
import { createWebhookEndpoint } from "@/modules/integrations";
import type { RevealState } from "@/components/forms/reveal-state";
import { adminRevealAction } from "@/app/admin/admin-action";
import { ENDPOINT_MESSAGES, endpointFields, endpointSchema } from "@/app/admin/webhooks/endpoint-input";

/** New endpoint page: adds the endpoint and shows its signing secret once. */
export async function createEndpointAction(_prev: RevealState, formData: FormData): Promise<RevealState> {
  return adminRevealAction(
    "webhook_endpoint_create",
    endpointFields(formData),
    endpointSchema,
    async (ctx, actor, input) =>
      map(await createWebhookEndpoint(ctx, actor, input), ({ endpoint, secret }) => ({
        value: secret,
        message: "Endpoint added. Here is its signing secret.",
        href: `/admin/webhooks/${endpoint.id}`,
      })),
    ENDPOINT_MESSAGES,
  );
}
