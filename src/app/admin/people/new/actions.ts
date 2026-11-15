"use server";

import { z } from "zod";
import { EMAIL_MAX_LENGTH } from "@/shared/kernel/names";
import { map } from "@/shared/lib/result";
import { invitePerson } from "@/modules/people";
import type { FormState } from "@/components/forms/form-state";
import { adminAction } from "@/app/admin/admin-action";
import { formFields } from "@/app/_lib/form-fields";
import { INVITE_MESSAGES, personFields } from "@/app/admin/people/person-input";

const inviteSchema = z.object({ email: formFields.text(EMAIL_MAX_LENGTH + 20), ...personFields });

/** Invite page: creates the person and emails them a sign-in link. */
export async function inviteAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "person_invite",
    formData,
    inviteSchema,
    async (ctx, actor, input) => map(await invitePerson(ctx, actor, input), (person) => `Invited. ${person.email} will get an email with a sign-in link.`),
    INVITE_MESSAGES,
  );
}
