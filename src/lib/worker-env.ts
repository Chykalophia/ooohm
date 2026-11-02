import { z } from "zod";
import { BUILD_PLACEHOLDER_ENCRYPTION_KEY, envError, integrationEnvShape, nonEmptyEnv } from "./integration-env";

/**
 * The outbox worker's environment: the database, the webhook encryption key, the two
 * development-only webhook flags, the log level and its poll interval. Deliberately not
 * `env.ts`, which requires the auth secret: the worker never holds auth or SMTP
 * secrets, and docker-compose gives it none.
 */
const schema = z.object({
  DATABASE_URL: z.string().url(),
  ...integrationEnvShape,
  /** How often an idle loop looks for work, in milliseconds. Busy loops go again at once. */
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  /** The longest an idle loop waits between looks, after backing off. */
  WORKER_MAX_IDLE_MS: z.coerce.number().int().min(100).max(300_000).default(10_000),
});

export type WorkerEnv = z.infer<typeof schema>;

/**
 * The outbox worker's settings, validated. Reads only what the worker needs, never the
 * app's auth or mail secrets; empty values count as unset.
 *
 * @throws Error naming every invalid or missing variable.
 */
export function loadWorkerEnv(source: Record<string, string | undefined> = process.env): WorkerEnv {
  const parsed = schema.safeParse(nonEmptyEnv(source));
  if (!parsed.success) throw envError(parsed.error);
  if (parsed.data.WEBHOOK_ENCRYPTION_KEY === BUILD_PLACEHOLDER_ENCRYPTION_KEY) {
    throw new Error("WEBHOOK_ENCRYPTION_KEY is the build placeholder. Set a real key.");
  }
  if (parsed.data.WORKER_MAX_IDLE_MS < parsed.data.WORKER_POLL_INTERVAL_MS) {
    throw new Error("WORKER_MAX_IDLE_MS must be at least WORKER_POLL_INTERVAL_MS.");
  }
  return parsed.data;
}
