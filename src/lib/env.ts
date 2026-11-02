import { z } from "zod";
import { resolveDatabaseConfig } from "@/db/config";
import { BACKGROUND_MODES, resolveBackgroundMode } from "./background-mode";
import { BUILD_PLACEHOLDER_ENCRYPTION_KEY, envError, integrationEnvShape, nonEmptyEnv } from "./integration-env";

const schema = z.object({
  // Checked in full by resolveDatabaseConfig (src/db/config.ts): a postgres:// URL, or
  // pglite:<dir> / OOOHM_DB=embedded for the embedded database.
  DATABASE_URL: z.string().optional(),
  DATABASE_URL_UNPOOLED: z.string().optional(),
  OOOHM_DB: z.enum(["postgres", "embedded"]).optional(),

  // Background work (see src/lib/background-mode.ts and docs/architecture.md).
  OOOHM_BACKGROUND: z.enum(BACKGROUND_MODES).optional(),
  /** How long one tick may start new work, in milliseconds. */
  OOOHM_TICK_BUDGET_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  /** Embedded mode: seconds between the in-process runner's ticks. */
  OOOHM_TICK_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3_600).default(30),
  /**
   * Authorizes GET /api/cron/tick (`Authorization: Bearer <secret>`; Vercel Cron sends it).
   * Optional: the route refuses every call while it is unset.
   */
  CRON_SECRET: z.string().min(32, "CRON_SECRET must be at least 32 characters (openssl rand -hex 32)").optional(),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),

  // Google sign-in is optional; the button only appears when both are set.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // Any SMTP server works. docker-compose ships Mailpit for local development.
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Refuse to send over a plain connection when STARTTLS is missing (see
  // src/lib/smtp-options.ts). On by default in production; Mailpit offers no TLS, so
  // the development compose and .env.example turn it off.
  SMTP_REQUIRE_TLS: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? process.env.NODE_ENV === "production" : v === "true")),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default("OOOhm <no-reply@ooohm.team>"),

  // How many reverse proxies in front of the app append to X-Forwarded-For. Rate limits
  // key on the client address only when this is set; see src/lib/client-address.ts.
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

  // Webhooks and logging (M6), shared with the outbox worker.
  ...integrationEnvShape,
});

// `next build` imports server modules to collect route info. Real secrets are only
// needed at runtime, so the build gets harmless placeholders instead of failing.
const isBuild = process.env.NEXT_PHASE === "phase-production-build";
const buildPlaceholders = {
  DATABASE_URL: "postgres://build:build@localhost:5432/build",
  BETTER_AUTH_SECRET: "build-time-placeholder-secret-not-used-at-runtime",
  WEBHOOK_ENCRYPTION_KEY: BUILD_PLACEHOLDER_ENCRYPTION_KEY,
};

function load() {
  const raw = nonEmptyEnv(process.env);
  const parsed = schema.safeParse(isBuild ? { ...buildPlaceholders, ...raw } : raw);
  if (!parsed.success) throw envError(parsed.error);
  // Defense in depth: the build placeholders must never sign real sessions or seal real secrets.
  if (!isBuild && parsed.data.BETTER_AUTH_SECRET === buildPlaceholders.BETTER_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET is still the build placeholder. Set a real secret.");
  }
  if (!isBuild && parsed.data.WEBHOOK_ENCRYPTION_KEY === BUILD_PLACEHOLDER_ENCRYPTION_KEY) {
    throw new Error("WEBHOOK_ENCRYPTION_KEY is still the build placeholder. Set a real key.");
  }
  const database = resolveDatabaseConfig(isBuild && !raw.DATABASE_URL && !raw.OOOHM_DB ? { ...raw, DATABASE_URL: buildPlaceholders.DATABASE_URL } : raw);
  const background = resolveBackgroundMode(parsed.data.OOOHM_BACKGROUND, { vercel: Boolean(raw.VERCEL), embedded: database.kind === "embedded" });
  return { ...parsed.data, database, background };
}

export const env = load();

export const googleEnabled = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
