"use server";

import { z } from "zod";
import { PERSON_NAME_MAX_LENGTH } from "@/shared/kernel/names";
import { COLOR_MODES } from "@/shared/kernel/color-mode";
import { renameSelf, setColorMode } from "@/modules/people";
import type { FormState } from "@/components/forms/form-state";
import { runFormAction } from "@/app/_lib/server-action";
import { map } from "@/shared/lib/result";

/** A refusal on your own account: it was deactivated (or deleted) since the page loaded. */
const ACCOUNT_LOCKED_MESSAGE = "Your account can't be changed right now. Sign in again.";
const NAME_LENGTH_MESSAGE = `Names are 1 to ${PERSON_NAME_MAX_LENGTH} characters.`;

/** Generous on length: the service trims and checks the real limit. */
const nameSchema = z.object({ name: z.string().max(PERSON_NAME_MAX_LENGTH * 2) });

/** Account page: saves the signed-in person's display name. */
export async function renameSelfAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return runFormAction(
    "account_rename",
    formData,
    nameSchema,
    async (ctx, actor, { name }) => map(await renameSelf(ctx, actor, name), () => "Saved."),
    { invalidInput: NAME_LENGTH_MESSAGE, messages: { invalid_input: NAME_LENGTH_MESSAGE, forbidden: ACCOUNT_LOCKED_MESSAGE } },
  );
}

const colorModeSchema = z.object({ colorMode: z.enum(COLOR_MODES) });

/** Account page: saves the signed-in person's colour mode. The refresh redraws the page in it. */
export async function setColorModeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return runFormAction(
    "account_color_mode",
    formData,
    colorModeSchema,
    async (ctx, actor, { colorMode }) => map(await setColorMode(ctx, actor, colorMode), () => "Saved."),
    { messages: { forbidden: ACCOUNT_LOCKED_MESSAGE } },
  );
}
