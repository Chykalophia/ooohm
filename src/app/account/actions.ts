"use server";

import { randomUUID } from "node:crypto";
import { refresh } from "next/cache";
import { z } from "zod";
import { PERSON_NAME_MAX_LENGTH } from "@/domain/people";
import { requireActor } from "@/lib/auth";
import { serviceContext } from "@/server/runtime";
import { renameSelf } from "@/server/services/account";
import type { FormState } from "@/app/form-state";
import { messageFor, runAction } from "@/app/run-action";

const nameSchema = z.object({ name: z.string().max(PERSON_NAME_MAX_LENGTH * 2) });

/** Account page: saves the signed-in person's display name. */
export async function renameSelfAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { actor } = await requireActor();
  if (!actor) return { status: "error", message: messageFor("no_company") };
  const parsed = nameSchema.safeParse({ name: formData.get("name") ?? "" });
  if (!parsed.success) return { status: "error", message: `Names are 1 to ${PERSON_NAME_MAX_LENGTH} characters.` };

  const state = await runAction(
    "account_rename",
    async () => {
      await renameSelf(serviceContext(), actor, parsed.data.name);
      return { id: randomUUID(), message: "Saved." };
    },
    { invalid_input: `Names are 1 to ${PERSON_NAME_MAX_LENGTH} characters.` },
  );
  if (state.status === "success") refresh();
  return state;
}
