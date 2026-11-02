import "server-only";
import { randomUUID } from "node:crypto";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Actor } from "@/domain/actor";
import { canAdminister } from "@/domain/admin-permissions";
import type { DomainErrorCode } from "@/domain/errors";
import { requireActor } from "@/lib/auth";
import { serviceContext } from "@/server/runtime";
import type { ServiceContext } from "@/server/context";
import type { FormState } from "@/app/form-state";
import { messageFor, runAction, runActionWith } from "@/app/run-action";
import type { RevealState } from "./reveal-state";

/**
 * Runs one admin server action: resolves the session (redirecting to sign-in without
 * one), refuses anyone who is not an admin, parses the form with `schema`, calls `work`
 * (one service call) through `runAction`, and refreshes the page on success.
 *
 * The service checks the admin role again inside its transaction; the check here only
 * spares a non-admin a database round trip.
 *
 * @param messages Wording for codes whose default message would not fit this action.
 */
export async function adminAction<S extends z.ZodType>(
  event: string,
  /** The submitted form, or fields already read from it (e.g. a multi-value checkbox group). */
  formData: FormData | Record<string, unknown>,
  schema: S,
  work: (ctx: ServiceContext, actor: Actor, input: z.infer<S>) => Promise<string>,
  messages: Partial<Record<DomainErrorCode, string>> = {},
): Promise<FormState> {
  const { actor } = await requireActor();
  if (!actor) return { status: "error", message: messageFor("no_company") };
  if (!canAdminister(actor)) return { status: "error", message: "Only admins can do that." };

  const parsed = schema.safeParse(formData instanceof FormData ? Object.fromEntries(formData) : formData);
  if (!parsed.success) return { status: "error", message: messageFor("invalid_input") };

  const state = await runAction(
    event,
    async () => ({ id: randomUUID(), message: await work(serviceContext(), actor, parsed.data) }),
    messages,
  );
  if (state.status === "success") refresh();
  return state;
}

/**
 * {@link adminAction} for an action whose success leaves the page behind (deleting a
 * person removes the page it was started from): `work` returns where to go, and the
 * browser is sent there. A refusal stays on the page as a calm message.
 */
export async function adminActionThenGo<S extends z.ZodType>(
  event: string,
  formData: FormData,
  schema: S,
  work: (ctx: ServiceContext, actor: Actor, input: z.infer<S>) => Promise<string>,
  messages: Partial<Record<DomainErrorCode, string>> = {},
): Promise<FormState> {
  const { actor } = await requireActor();
  if (!actor) return { status: "error", message: messageFor("no_company") };
  if (!canAdminister(actor)) return { status: "error", message: "Only admins can do that." };

  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { status: "error", message: messageFor("invalid_input") };

  const outcome = await runActionWith(event, async () => ({ status: "go" as const, path: await work(serviceContext(), actor, parsed.data) }), messages);
  // Outside the try in runActionWith: redirect() throws to do its work.
  if (outcome.status === "go") redirect(outcome.path);
  return outcome;
}

/**
 * {@link adminAction} for actions whose success reveals a secret once (a webhook signing
 * secret, an API key): `work` returns the secret, the message to show with it and,
 * optionally, where to go next. The secret goes back in this response only and is never
 * logged.
 */
export async function adminRevealAction<S extends z.ZodType>(
  event: string,
  formData: FormData | Record<string, unknown>,
  schema: S,
  work: (ctx: ServiceContext, actor: Actor, input: z.infer<S>) => Promise<{ value: string; message: string; href?: string }>,
  messages: Partial<Record<DomainErrorCode, string>> = {},
): Promise<RevealState> {
  const { actor } = await requireActor();
  if (!actor) return { status: "error", message: messageFor("no_company") };
  if (!canAdminister(actor)) return { status: "error", message: "Only admins can do that." };

  const parsed = schema.safeParse(formData instanceof FormData ? Object.fromEntries(formData) : formData);
  if (!parsed.success) return { status: "error", message: messageFor("invalid_input") };

  const state = await runActionWith(
    event,
    async (): Promise<RevealState> => ({ status: "revealed", id: randomUUID(), ...(await work(serviceContext(), actor, parsed.data)) }),
    messages,
  );
  if (state.status === "revealed") refresh();
  return state;
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
