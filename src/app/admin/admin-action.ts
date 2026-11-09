import "server-only";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
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

/**
 * {@link adminAction} for an action whose result is its own state type (a preview, then
 * an outcome), which the page renders itself; `work` returns that state. The page is not
 * refreshed: the state carries what changed.
 */
export function adminStateAction<S extends z.ZodType, R extends { status: string }>(
  event: string,
  input: ActionInput,
  schema: S,
  work: ActionWork<S, R>,
  messages: Partial<Record<DomainErrorCode, string>> = {},
) {
  return runStateAction(event, input, schema, work, { who: "admin", messages, refresh: false });
}
