import "server-only";
import { after } from "next/server";
import { db } from "@/db";
import { issueSignInLink } from "@/lib/auth";
import { env } from "@/lib/env";
import { createSecretBox } from "@/lib/integration-crypto";
import { sendMail } from "@/lib/mail";
import type { ServiceContext } from "./context";
import { adapterRegistry } from "./integrations/adapter";

const secrets = createSecretBox(env.WEBHOOK_ENCRYPTION_KEY);
const webhookTargets = { allowInsecure: env.WEBHOOK_ALLOW_INSECURE, allowPrivate: env.WEBHOOK_ALLOW_PRIVATE };

/**
 * The inline background tick, registered once per process by `src/instrumentation-node.ts`
 * in `inline` mode. Kept on `globalThis` so every module graph in the process sees it;
 * this module cannot import the tick itself, which is a service.
 */
const registry = globalThis as unknown as { ooohmWake?: () => Promise<void> };

/** Registers what `ctx.wake` runs after a change (inline background mode). */
export function setBackgroundWake(wake: (() => Promise<void>) | undefined): void {
  registry.ooohmWake = wake;
}

/**
 * Composition root: the production `ServiceContext`. Only the presentation layer
 * (pages, server actions, route handlers) calls this; services receive the result.
 */
export function serviceContext(): ServiceContext {
  return {
    db,
    mailer: sendMail,
    defer: (task) => after(task),
    appUrl: env.BETTER_AUTH_URL.replace(/\/+$/, ""),
    now: () => new Date(),
    issueSignInLink,
    secrets,
    webhookTargets,
    adapters: adapterRegistry,
    wake: registry.ooohmWake,
  };
}

/**
 * The context background ticks run in, outside any request: deferred work runs at once
 * (there is no response to wait for, and `after()` exists only inside a request), and a
 * tick never wakes another; the tick itself goes round again when its jobs wrote events.
 */
export function backgroundContext(): ServiceContext {
  return { ...serviceContext(), defer: (task) => void task(), wake: undefined };
}
