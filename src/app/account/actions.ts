"use server";

import { z } from "zod";
import { PERSON_NAME_MAX_LENGTH } from "@/domain/people";
import { THEMES } from "@/domain/theme";
import { renameSelf, setTheme } from "@/server/services/account";
import type { FormState } from "@/components/forms/form-state";
import { runFormAction } from "@/app/_lib/server-action";

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
    async (ctx, actor, { name }) => {
      await renameSelf(ctx, actor, name);
      return "Saved.";
    },
    { invalidInput: NAME_LENGTH_MESSAGE, messages: { invalid_input: NAME_LENGTH_MESSAGE, forbidden: ACCOUNT_LOCKED_MESSAGE } },
  );
}

const themeSchema = z.object({ theme: z.enum(THEMES) });

/** Account page: saves how the signed-in person wants the app drawn. The refresh redraws it. */
export async function setThemeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return runFormAction(
    "account_theme",
    formData,
    themeSchema,
    async (ctx, actor, { theme }) => {
      await setTheme(ctx, actor, theme);
      return "Saved.";
    },
    { messages: { forbidden: ACCOUNT_LOCKED_MESSAGE } },
  );
}
