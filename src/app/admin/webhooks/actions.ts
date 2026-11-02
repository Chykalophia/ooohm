"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { WEBHOOK_DESCRIPTION_MAX_LENGTH } from "@/domain/integrations";
import { WEBHOOK_URL_MAX_LENGTH } from "@/domain/webhook-target";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  redeliverWebhook,
  rotateWebhookSecret,
  sendWebhookPing,
  setWebhookEndpointEnabled,
  updateWebhookEndpoint,
} from "@/server/services/webhooks";
import type { FormState } from "@/components/forms/form-state";
import { adminAction, adminRevealAction } from "@/app/admin/admin-action";
import { formFields } from "@/app/_lib/form-fields";
import type { RevealState } from "@/components/forms/reveal-state";

const MESSAGES = {
  not_found: "That endpoint doesn't exist any more.",
  invalid_input: "Check the URL and description, and pick at least one event.",
  limit_reached: "That's as many endpoints as a company can have. Delete one you no longer use first.",
};

const endpointSchema = z.object({
  url: formFields.text(WEBHOOK_URL_MAX_LENGTH + 100),
  description: formFields.text(WEBHOOK_DESCRIPTION_MAX_LENGTH * 2).optional().default(""),
  eventTypes: z.array(z.string().max(100)).max(100),
});

/** The form's fields, with the event type checkboxes as a list. */
function endpointFields(formData: FormData) {
  return { ...Object.fromEntries(formData), eventTypes: formData.getAll("eventTypes") };
}

export async function createEndpointAction(_prev: RevealState, formData: FormData): Promise<RevealState> {
  return adminRevealAction(
    "webhook_endpoint_create",
    endpointFields(formData),
    endpointSchema,
    async (ctx, actor, input) => {
      const { endpoint, secret } = await createWebhookEndpoint(ctx, actor, input);
      return { value: secret, message: "Endpoint added. Here is its signing secret.", href: `/admin/webhooks/${endpoint.id}` };
    },
    MESSAGES,
  );
}

export async function updateEndpointAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "webhook_endpoint_update",
    endpointFields(formData),
    endpointSchema.extend({ id: formFields.id }),
    async (ctx, actor, { id, ...input }) => ((await updateWebhookEndpoint(ctx, actor, id, input)) ? "Saved." : "Nothing changed."),
    MESSAGES,
  );
}

export async function setEndpointEnabledAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "webhook_endpoint_toggle",
    formData,
    z.object({ id: formFields.id, enabled: z.enum(["true", "false"]) }),
    async (ctx, actor, { id, enabled }) => {
      await setWebhookEndpointEnabled(ctx, actor, id, enabled === "true");
      return enabled === "true" ? "Turned on." : "Turned off. Nothing is sent until you turn it back on.";
    },
    MESSAGES,
  );
}

export async function rotateSecretAction(_prev: RevealState, formData: FormData): Promise<RevealState> {
  return adminRevealAction(
    "webhook_endpoint_rotate_secret",
    formData,
    z.object({ id: formFields.id }),
    async (ctx, actor, { id }) => ({ value: (await rotateWebhookSecret(ctx, actor, id)).secret, message: "New signing secret. The old one no longer works." }),
    MESSAGES,
  );
}

export async function sendPingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "webhook_endpoint_ping",
    formData,
    z.object({ id: formFields.id }),
    async (ctx, actor, { id }) => {
      await sendWebhookPing(ctx, actor, id);
      return "Test event queued. It shows below once it's sent, usually within a few seconds.";
    },
    { ...MESSAGES, conflict: "Turn the endpoint on first." },
  );
}

export async function redeliverAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "webhook_redeliver",
    formData,
    z.object({ endpointId: formFields.id, deliveryId: formFields.id }),
    async (ctx, actor, { endpointId, deliveryId }) => {
      await redeliverWebhook(ctx, actor, endpointId, deliveryId);
      return "Queued again.";
    },
    { ...MESSAGES, not_found: "That delivery doesn't exist any more.", conflict: "It's already queued, or the endpoint is off." },
  );
}

/** Deletes the endpoint, then leaves its page (which no longer exists) for the list. */
export async function deleteEndpointAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const state = await adminAction(
    "webhook_endpoint_delete",
    formData,
    z.object({ id: formFields.id }),
    async (ctx, actor, { id }) => {
      await deleteWebhookEndpoint(ctx, actor, id);
      return "Deleted.";
    },
    MESSAGES,
  );
  if (state.status === "success") redirect("/admin/webhooks");
  return state;
}
