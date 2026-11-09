"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { isDomainError } from "@/domain/errors";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { serviceContext } from "@/server/runtime";
import { runFirstInstall } from "@/server/services/install";
import type { FormState } from "@/components/forms/form-state";
import { formFields } from "@/app/_lib/form-fields";

const setupSchema = z.object({
  token: formFields.text(512),
  companyName: formFields.text(200),
  timezone: formFields.text(100),
  adminName: formFields.text(200),
  adminEmail: formFields.text(320),
});

/** The setup form's own names for the fields a domain check blames (people's rules say `email`, `name`). */
const FORM_FIELD: Record<string, string> = { email: "adminEmail", name: "adminName" };

/** The form field an `invalid_input` refusal names, if it names one. */
function blamedField(err: unknown): string[] | undefined {
  if (!isDomainError(err, "invalid_input") || !err.details || !("field" in err.details)) return undefined;
  const field = err.details.field;
  return [FORM_FIELD[field] ?? field];
}

/**
 * Sets up a brand-new install (no session: the setup token is the credential, checked
 * by the service), then sends the new admin to sign in with their email.
 */
export async function runSetupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = setupSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { status: "error", message: "Fill in every field." };
  let email: string;
  try {
    ({ email } = await runFirstInstall(serviceContext(), parsed.data, env.SETUP_TOKEN));
  } catch (err) {
    // Naming the field marks it invalid and moves focus there, as every other form does.
    if (isDomainError(err, "forbidden")) return { status: "error", message: "That setup token isn't right.", fields: ["token"] };
    if (isDomainError(err, "not_found")) return { status: "error", message: "OOOhm is already set up. Sign in instead." };
    if (isDomainError(err, "invalid_input")) return { status: "error", message: err.message, fields: blamedField(err) };
    log.error({ err }, "first_install_failed");
    return { status: "error", message: "Something went wrong, and nothing was saved. Try again." };
  }
  redirect(`/sign-in?${new URLSearchParams({ setup: "done", email })}`);
}
