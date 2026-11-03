import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { Actor } from "@/domain/actor";
import { canAdminister } from "@/domain/admin-permissions";
import type { DomainErrorCode } from "@/domain/errors";
import type { ServiceContext } from "@/server/context";
import type { FormState } from "@/components/forms/form-state";
import { type ActionError, messageFor, runActionWith } from "./run-action";

/**
 * The pipeline every server action shares, so each action is only its schema and its
 * one service call:
 *
 * 1. the session (the `actor` dependency redirects to sign-in without one);
 * 2. a company, and for `admin` actions the admin role (the service checks the role
 *    again inside its transaction; this only spares a refused caller a round trip);
 * 3. the submitted fields, parsed with the action's schema;
 * 4. the service call, through {@link runActionWith}, so expected failures become calm
 *    messages and nothing internal reaches the browser;
 * 5. a refresh of the page after a success, unless the action opts out.
 *
 * Built from its framework dependencies so the order of these steps can be tested
 * without Next.js; `src/app/_lib/server-action.ts` wires the real ones.
 */

/** The submitted form, or fields already read from it (e.g. a multi-value checkbox group). */
export type ActionInput = FormData | Record<string, unknown>;

/** One service call made by an action, with the parsed input. */
export type ActionWork<S extends z.ZodType, R> = (ctx: ServiceContext, actor: Actor, input: z.infer<S>) => Promise<R>;

export type ActionOptions = {
  /** Who may run it: any member of the company (the default), or admins only. */
  who?: "member" | "admin";
  /** Wording for codes whose default message would not fit this action. */
  messages?: Partial<Record<DomainErrorCode, string>>;
  /** The message for input the schema refuses, when the generic one would not help. */
  invalidInput?: string;
  /** Refresh the page after a success (default). Off where the page keeps showing the outcome itself. */
  refresh?: boolean;
};

export type PipelineDeps = {
  /** The signed-in person's actor, `null` without a company; redirects to sign-in without a session. */
  actor: () => Promise<Actor | null>;
  context: () => ServiceContext;
  refresh: () => void;
  /** Sends the browser elsewhere; never returns (Next.js throws to do it). */
  redirect: (path: string) => never;
};

export function createActionPipeline(deps: PipelineDeps) {
  async function authorize<S extends z.ZodType>(
    input: ActionInput,
    schema: S,
    options: ActionOptions,
  ): Promise<{ actor: Actor; data: z.infer<S> } | ActionError> {
    const actor = await deps.actor();
    if (!actor) return { status: "error", message: messageFor("no_company") };
    if (options.who === "admin" && !canAdminister(actor)) return { status: "error", message: "Only admins can do that." };

    const parsed = schema.safeParse(input instanceof FormData ? Object.fromEntries(input) : input);
    if (!parsed.success) return { status: "error", message: options.invalidInput ?? messageFor("invalid_input") };
    return { actor, data: parsed.data };
  }

  /**
   * Runs an action whose result is its own state type (a revealed secret, a new calendar
   * link): `work` returns the success state. The page is refreshed after any state other
   * than an error.
   */
  async function runStateAction<S extends z.ZodType, R extends { status: string }>(
    event: string,
    input: ActionInput,
    schema: S,
    work: ActionWork<S, R>,
    options: ActionOptions = {},
  ): Promise<R | ActionError> {
    const auth = await authorize(input, schema, options);
    if ("status" in auth) return auth;
    const state = await runActionWith(event, () => work(deps.context(), auth.actor, auth.data), options.messages);
    if (state.status !== "error" && options.refresh !== false) deps.refresh();
    return state;
  }

  /** Runs an action whose success is a calm message: `work` returns the message to show. */
  function runFormAction<S extends z.ZodType>(
    event: string,
    input: ActionInput,
    schema: S,
    work: ActionWork<S, string>,
    options: ActionOptions = {},
  ): Promise<FormState> {
    return runStateAction(
      event,
      input,
      schema,
      async (ctx, actor, data) => ({ status: "success", message: await work(ctx, actor, data), id: randomUUID() }) as const,
      options,
    );
  }

  /**
   * Runs an action whose success leaves the page behind (deleting a person removes the
   * page it was started from): `work` returns where to go, and the browser is sent there.
   * A refusal stays on the page as a calm message.
   */
  async function runActionThenGo<S extends z.ZodType>(
    event: string,
    input: ActionInput,
    schema: S,
    work: ActionWork<S, string>,
    options: ActionOptions = {},
  ): Promise<FormState> {
    const outcome = await runStateAction(
      event,
      input,
      schema,
      async (ctx, actor, data) => ({ status: "go", path: await work(ctx, actor, data) }) as const,
      { ...options, refresh: false },
    );
    // Outside the try in runActionWith: redirect() throws to do its work.
    if (outcome.status === "go") deps.redirect(outcome.path);
    return outcome as FormState;
  }

  return { runStateAction, runFormAction, runActionThenGo };
}
