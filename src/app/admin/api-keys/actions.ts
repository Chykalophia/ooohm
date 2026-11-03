"use server";

import { z } from "zod";
import { API_KEY_NAME_MAX_LENGTH } from "@/domain/integrations";
import { createApiKey, revokeApiKey } from "@/server/services/api-keys";
import type { FormState } from "@/components/forms/form-state";
import { adminAction, adminRevealAction } from "@/app/admin/admin-action";
import { formFields } from "@/app/_lib/form-fields";
import type { RevealState } from "@/components/forms/reveal-state";

const MESSAGES = {
  not_found: "That key doesn't exist any more.",
  invalid_input: `Key names are 1 to ${API_KEY_NAME_MAX_LENGTH} characters.`,
  limit_reached: "That's as many keys as a company can have. Revoke one you no longer use first.",
};

export async function createApiKeyAction(_prev: RevealState, formData: FormData): Promise<RevealState> {
  return adminRevealAction(
    "api_key_create",
    formData,
    z.object({ name: formFields.text(API_KEY_NAME_MAX_LENGTH * 2) }),
    async (ctx, actor, { name }) => {
      const { key, apiKey } = await createApiKey(ctx, actor, { name });
      return { value: key, message: `Created ${apiKey.name}. Here is the key.` };
    },
    MESSAGES,
  );
}

export async function revokeApiKeyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "api_key_revoke",
    formData,
    z.object({ id: formFields.id }),
    async (ctx, actor, { id }) => ((await revokeApiKey(ctx, actor, id)) ? "Revoked. Requests with it now get 401." : "It was already revoked."),
    MESSAGES,
  );
}
