import "server-only";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { requireActor } from "@/lib/auth";
import { serviceContext } from "@/server/runtime";
import { createActionPipeline } from "./action-pipeline";

export type { ActionInput, ActionOptions, ActionWork } from "./action-pipeline";

/** The app's server action pipeline (see `action-pipeline.ts`), wired to the session and Next.js. */
export const { runStateAction, runFormAction, runActionThenGo } = createActionPipeline({
  actor: async () => (await requireActor()).actor,
  context: serviceContext,
  refresh,
  redirect,
});
