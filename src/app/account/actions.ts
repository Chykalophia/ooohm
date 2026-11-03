"use server";

import { z } from "zod";
import { PERSON_NAME_MAX_LENGTH } from "@/domain/people";
import { renameSelf } from "@/server/services/account";
import type { FormState } from "@/components/forms/form-state";
import { runFormAction } from "@/app/_lib/server-action";

const NAME_LENGTH_MESSAGE = `Names are 1 to ${PERSON_NAME_MAX_LENGTH} characters.`;

/** Generous on length: the service trims and checks the real limit. */
const nameSchema = z.object({ name: z.string().max(PERSON_NAME_MAX_LENGTH * 2) });

/** Account page: saves the signed-in person's display name. */
export async function renameSelfAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return runFormAction(
    "account_rename",
    formData,
    nameSchema,
    async (ctx, actor, { name }) => {
      await renameSelf(ctx, actor, name);
      return "Saved.";
    },
    { invalidInput: NAME_LENGTH_MESSAGE, messages: { invalid_input: NAME_LENGTH_MESSAGE } },
  );
}
