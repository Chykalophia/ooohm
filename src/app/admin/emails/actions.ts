"use server";

import { z } from "zod";
import { EMAIL_MESSAGE_MAX, EMAIL_SUBJECT_MAX } from "@/domain/email-template";
import { previewEmail, resetEmailCopy, saveEmailCopy } from "@/modules/notifications";
import { map } from "@/shared/lib/result";
import type { FormState } from "@/components/forms/form-state";
import { adminAction } from "@/app/admin/admin-action";
import { formFields } from "@/app/_lib/form-fields";
import { runStateAction } from "@/app/_lib/server-action";

const MESSAGES = {
  not_found: "That email doesn't exist.",
  invalid_input: "Use only the variables listed beside the fields, keep the subject under 150 characters and the message under 2,000.",
};

// Room for whitespace the service trims; it checks the real limits.
const copySchema = z.object({
  type: formFields.id,
  subject: formFields.text(EMAIL_SUBJECT_MAX * 2),
  message: formFields.text(EMAIL_MESSAGE_MAX * 2),
});

/** Saves the company's words for one email. */
export async function saveEmailCopyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "email_copy_save",
    formData,
    copySchema,
    async (ctx, actor, { type, subject, message }) =>
      map(await saveEmailCopy(ctx, actor, type, { subject, message }), (saved) =>
        saved.subject === null && saved.message === null
          ? "Saved. This email uses OOOhm's own wording."
          : "Saved. The next emails of this kind go out with your wording.",
      ),
    MESSAGES,
  );
}

/** Puts one email back to OOOhm's own wording. */
export async function resetEmailCopyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "email_copy_reset",
    formData,
    z.object({ type: formFields.id }),
    async (ctx, actor, { type }) => map(await resetEmailCopy(ctx, actor, type), () => "Back to OOOhm's own wording."),
    MESSAGES,
  );
}

export type PreviewState = { status: "preview"; subject: string; html: string } | { status: "error"; message: string; fields?: string[] };

/** The email as the draft would send it, with made-up data. Saves nothing. */
export async function previewEmailAction(draft: { type: string; subject: string; message: string }): Promise<PreviewState> {
  return runStateAction(
    "email_copy_preview",
    draft,
    copySchema,
    async (ctx, actor, { type, subject, message }) =>
      map(await previewEmail(ctx, actor, type, { subject, message }), (preview) => ({ status: "preview" as const, ...preview })),
    { who: "admin", messages: MESSAGES, refresh: false },
  );
}
