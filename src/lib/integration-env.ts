import { z } from "zod";
import { parseEncryptionKey } from "./integration-crypto";

/**
 * Environment variables shared by the app (`env.ts`) and the outbox worker
 * (`worker-env.ts`). Kept apart so the worker validates only what it is given: it never
 * sees the auth secret or SMTP credentials.
 */

/** A `true` / `false` variable, `false` when unset. */
export const envFlag = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

export const integrationEnvShape = {
  /** 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts webhook signing secrets at rest. */
  WEBHOOK_ENCRYPTION_KEY: z
    .string()
    .refine((v) => parseEncryptionKey(v) !== null, "WEBHOOK_ENCRYPTION_KEY must be 32 bytes in base64 (openssl rand -base64 32)"),
  /** Local development only: allow `http://` webhook URLs. */
  WEBHOOK_ALLOW_INSECURE: envFlag,
  /** Local development only: allow webhooks to loopback, private and link-local addresses. */
  WEBHOOK_ALLOW_PRIVATE: envFlag,
  /** Least severe log level written: `debug`, `info` (default), `warn` or `error`. Read by `log.ts` itself. */
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
};

/** A placeholder key for `next build`, which imports server modules but never encrypts anything. */
export const BUILD_PLACEHOLDER_ENCRYPTION_KEY = Buffer.alloc(32, 0x5a).toString("base64");

/**
 * Trims every value and treats `KEY=` (empty, or only whitespace) as unset, so defaults
 * apply. Trimming matters on hosts whose secret stores keep a trailing newline pasted or
 * piped in with a value (`echo value | vercel env add`): a newline in a key or password
 * reaches HTTP headers and SMTP logins, where it fails far from its cause.
 */
export function nonEmptyEnv(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(source)) {
    const value = raw?.trim();
    if (value) out[key] = value;
  }
  return out;
}

/** One readable error for a failed parse, instead of a stack trace deep inside a request. */
export function envError(error: z.ZodError): Error {
  const issues = error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
  return new Error(`Invalid environment configuration:\n${issues.join("\n")}`);
}
