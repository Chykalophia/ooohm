import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DomainErrorCode } from "@/domain/errors";
import type { FormState } from "@/components/forms/form-state";
import type { RevealState } from "@/components/forms/reveal-state";
import { type ActionInput, type ActionWork, runActionThenGo, runFormAction, runStateAction } from "@/app/_lib/server-action";

/**
 * Admin server actions: the shared action pipeline (src/app/_lib/server-action.ts) with
 * the admin role required. Each returns what the admin forms render.
 *
 * @param messages Wording for codes whose default message would not fit this action.
 */
export function adminAction<S extends z.ZodType>(
  event: string,
  input: ActionInput,
  schema: S,
  work: ActionWork<S, string>,
  messages: Partial<Record<DomainErrorCode, string>> = {},
): Promise<FormState> {
  return runFormAction(event, input, schema, work, { who: "admin", messages });
}

/** {@link adminAction} for an action whose success leaves the page behind; `work` returns where to go. */
export function adminActionThenGo<S extends z.ZodType>(
  event: string,
  input: ActionInput,
  schema: S,
  work: ActionWork<S, string>,
  messages: Partial<Record<DomainErrorCode, string>> = {},
): Promise<FormState> {
  return runActionThenGo(event, input, schema, work, { who: "admin", messages });
}

/**
 * {@link adminAction} for actions whose success reveals a secret once (a webhook signing
 * secret, an API key): `work` returns the secret, the message to show with it and,
 * optionally, where to go next. The secret goes back in this response only and is never
 * logged.
 */
export function adminRevealAction<S extends z.ZodType>(
  event: string,
  input: ActionInput,
  schema: S,
  work: ActionWork<S, { value: string; message: string; href?: string }>,
  messages: Partial<Record<DomainErrorCode, string>> = {},
): Promise<RevealState> {
  return runStateAction(
    event,
    input,
    schema,
    async (ctx, actor, data): Promise<RevealState> => ({ status: "revealed", id: randomUUID(), ...(await work(ctx, actor, data)) }),
    { who: "admin", messages },
  );
}

/** Form field schemas. Browsers send every field as a string; a checkbox only when ticked. */
export const formFields = {
  text: (max: number) => z.string().max(max),
  id: z.string().min(1).max(100),
  /** A select whose empty option means "none". */
  optionalId: z
    .string()
    .max(100)
    .optional()
    .transform((v) => (v ? v : null)),
  checkbox: z
    .string()
    .optional()
    .transform((v) => v === "on"),
  /** A number field; blank means "none". */
  optionalNumber: z
    .string()
    .max(20)
    .optional()
    .transform((v, ctx) => {
      const trimmed = v?.trim() ?? "";
      if (trimmed === "") return null;
      const n = Number(trimmed);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: "custom", message: "Not a number" });
        return z.NEVER;
      }
      return n;
    }),
  number: z
    .string()
    .max(20)
    .transform((v, ctx) => {
      const n = v.trim() === "" ? Number.NaN : Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: "custom", message: "Not a number" });
        return z.NEVER;
      }
      return n;
    }),
};
