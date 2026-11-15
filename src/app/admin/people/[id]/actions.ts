"use server";

import { z } from "zod";
import { map } from "@/shared/lib/result";
import { deactivatePerson, reactivatePerson, resendInvite, updatePerson } from "@/modules/people";
import type { FormState } from "@/components/forms/form-state";
import { adminAction } from "@/app/admin/admin-action";
import { formFields } from "@/app/_lib/form-fields";
import { deactivationMessage } from "@/app/admin/people/deactivation-message";
import { INVITE_MESSAGES, PERSON_MESSAGES, personFields, personSchema } from "@/app/admin/people/person-input";

const editSchema = z.object({ userId: formFields.id, ...personFields });

/** Person page: saves name, department, manager, role and self-approval. */
export async function updatePersonAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "person_update",
    formData,
    editSchema,
    async (ctx, actor, { userId, ...input }) =>
      map(await updatePerson(ctx, actor, userId, input), ({ requestsReassigned: n }) =>
        n === 0 ? "Saved." : `Saved. ${n} pending ${n === 1 ? "request" : "requests"} moved to another approver.`,
      ),
    PERSON_MESSAGES,
  );
}

export async function resendInviteAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "person_resend_invite",
    formData,
    personSchema,
    async (ctx, actor, { userId }) => map(await resendInvite(ctx, actor, userId), (person) => `Sent. ${person.email} will get a new sign-in link.`),
    { ...PERSON_MESSAGES, forbidden: "Reactivate them before sending a link.", rate_limited: INVITE_MESSAGES.rate_limited },
  );
}

export async function deactivateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "person_deactivate",
    formData,
    personSchema,
    async (ctx, actor, { userId }) => map(await deactivatePerson(ctx, actor, userId), deactivationMessage),
    PERSON_MESSAGES,
  );
}

export async function reactivateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "person_reactivate",
    formData,
    personSchema,
    async (ctx, actor, { userId }) => map(await reactivatePerson(ctx, actor, userId), () => "Reactivated. They can sign in again."),
    PERSON_MESSAGES,
  );
}
