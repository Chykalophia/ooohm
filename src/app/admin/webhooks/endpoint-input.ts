import "server-only";
import { z } from "zod";
import { WEBHOOK_DESCRIPTION_MAX_LENGTH } from "@/modules/integrations";
import { WEBHOOK_URL_MAX_LENGTH } from "@/domain/webhook-target";
import { formFields } from "@/app/_lib/form-fields";

/** Wording for the webhook actions' refusals. */
export const ENDPOINT_MESSAGES = {
  not_found: "That endpoint doesn't exist any more.",
  invalid_input: "Check the URL and description, and pick at least one event.",
  limit_reached: "That's as many endpoints as a company can have. Delete one you no longer use first.",
};

/** An endpoint's form: its URL, description and the events it gets. */
export const endpointSchema = z.object({
  url: formFields.text(WEBHOOK_URL_MAX_LENGTH + 100),
  description: formFields.text(WEBHOOK_DESCRIPTION_MAX_LENGTH * 2).optional().default(""),
  eventTypes: z.array(z.string().max(100)).max(100),
});

/** The form's fields, with the event type checkboxes as a list. */
export function endpointFields(formData: FormData) {
  return { ...Object.fromEntries(formData), eventTypes: formData.getAll("eventTypes") };
}
