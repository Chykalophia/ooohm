import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),

  // Google sign-in is optional; the button only appears when both are set.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // Any SMTP server works. docker-compose ships Mailpit for local development.
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default("OOOhm <no-reply@ooohm.team>"),
});

// `next build` imports server modules to collect route info. Real secrets are only
// needed at runtime, so the build gets harmless placeholders instead of failing.
const isBuild = process.env.NEXT_PHASE === "phase-production-build";
const buildPlaceholders = {
  DATABASE_URL: "postgres://build:build@localhost:5432/build",
  BETTER_AUTH_SECRET: "build-time-placeholder-secret-not-used-at-runtime",
};

function load() {
  // Treat `KEY=` (empty) the same as unset so defaults apply.
  const raw = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ""));
  const parsed = schema.safeParse(isBuild ? { ...buildPlaceholders, ...raw } : raw);
  if (!parsed.success) {
    // Fail fast with a readable list instead of a stack trace deep inside a request.
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join("\n")}`);
  }
  // Defense in depth: the build placeholder must never sign real sessions.
  if (!isBuild && parsed.data.BETTER_AUTH_SECRET === buildPlaceholders.BETTER_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET is still the build placeholder. Set a real secret.");
  }
  return parsed.data;
}

export const env = load();

export const googleEnabled = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
