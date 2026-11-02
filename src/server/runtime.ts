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
  };
}
