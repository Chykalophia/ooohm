import "server-only";
import { after } from "next/server";
import { db } from "@/db";
import { env } from "@/lib/env";
import { sendMail } from "@/lib/mail";
import type { ServiceContext } from "./context";

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
  };
}
