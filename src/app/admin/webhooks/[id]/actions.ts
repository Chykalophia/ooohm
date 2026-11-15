"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { map } from "@/shared/lib/result";
import { deleteWebhookEndpoint, redeliverWebhook, rotateWebhookSecret, sendWebhookPing, setWebhookEndpointEnabled, updateWebhookEndpoint } from "@/modules/integrations";
import type { FormState } from "@/components/forms/form-state";
import type { RevealState } from "@/components/forms/reveal-state";
import { adminAction, adminRevealAction } from "@/app/admin/admin-action";
import { formFields } from "@/app/_lib/form-fields";
import { ENDPOINT_MESSAGES as MESSAGES, endpointFields, endpointSchema } from "@/app/admin/webhooks/endpoint-input";

export async function updateEndpointAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "webhook_endpoint_update",
    endpointFields(formData),
    endpointSchema.extend({ id: formFields.id }),
    async (ctx, actor, { id, ...input }) => map(await updateWebhookEndpoint(ctx, actor, id, input), (changed) => (changed ? "Saved." : "Nothing changed.")),
    MESSAGES,
  );
}

export async function setEndpointEnabledAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "webhook_endpoint_toggle",
    formData,
    z.object({ id: formFields.id, enabled: z.enum(["true", "false"]) }),
    async (ctx, actor, { id, enabled }) =>
      map(await setWebhookEndpointEnabled(ctx, actor, id, enabled === "true"), () =>
        enabled === "true" ? "Turned on." : "Turned off. Nothing is sent until you turn it back on.",
      ),
    MESSAGES,
  );
}

export async function rotateSecretAction(_prev: RevealState, formData: FormData): Promise<RevealState> {
  return adminRevealAction(
    "webhook_endpoint_rotate_secret",
    formData,
    z.object({ id: formFields.id }),
    async (ctx, actor, { id }) =>
      map(await rotateWebhookSecret(ctx, actor, id), ({ secret }) => ({ value: secret, message: "New signing secret. The old one no longer works." })),
    MESSAGES,
  );
}

export async function sendPingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "webhook_endpoint_ping",
    formData,
    z.object({ id: formFields.id }),
    async (ctx, actor, { id }) =>
      map(await sendWebhookPing(ctx, actor, id), () => "Test event queued. It shows below once it's sent, usually within a few seconds."),
    { ...MESSAGES, conflict: "Turn the endpoint on first." },
  );
}

export async function redeliverAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "webhook_redeliver",
    formData,
    z.object({ endpointId: formFields.id, deliveryId: formFields.id }),
    async (ctx, actor, { endpointId, deliveryId }) => map(await redeliverWebhook(ctx, actor, endpointId, deliveryId), () => "Queued again."),
    { ...MESSAGES, not_found: "That delivery doesn't exist any more.", conflict: "It's already queued, or the endpoint is off." },
  );
}

/** Deletes the endpoint, then leaves its page (which no longer exists) for the list. */
export async function deleteEndpointAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const state = await adminAction(
    "webhook_endpoint_delete",
    formData,
    z.object({ id: formFields.id }),
    async (ctx, actor, { id }) => map(await deleteWebhookEndpoint(ctx, actor, id), () => "Deleted."),
    MESSAGES,
  );
  if (state.status === "success") redirect("/admin/webhooks");
  return state;
}
