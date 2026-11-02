import "server-only";

type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

const SEVERITY: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * The least severe level written, from `LOG_LEVEL` (`debug`, `info`, `warn`, `error`;
 * default `info`). Read here rather than through `env.ts`, so processes that do not load
 * the app's environment (the outbox worker, jobs) honour it too.
 */
function minimumLevel(): number {
  const configured = process.env.LOG_LEVEL;
  return configured && configured in SEVERITY ? SEVERITY[configured as Level] : SEVERITY.info;
}

/**
 * Structured JSON-lines logger for server code. `debug`/`info` go to stdout,
 * `warn`/`error` to stderr, so log collectors can classify levels.
 */
function write(level: Level, fields: Fields, event: string) {
  if (SEVERITY[level] < minimumLevel()) return;
  // Caller fields go first so they can never overwrite the reserved keys.
  const line = JSON.stringify({ ...serialize(fields), time: new Date().toISOString(), level, event });
  (SEVERITY[level] <= SEVERITY.info ? process.stdout : process.stderr).write(line + "\n");
}

// Error objects have no enumerable fields, so JSON.stringify would drop them.
function serialize(fields: Fields): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? serializeError(v) : v;
  }
  return out;
}

type ErrorFields = Error & Record<string, unknown>;

/**
 * The loggable part of an error, with personal data left out.
 *
 * - Drizzle query errors put every bound parameter (notes, decline reasons, audit
 *   JSON) in `message` and `stack`; only the SQL text and the driver's code and
 *   message are kept.
 * - SMTP errors (nodemailer) quote the server's reply, which usually contains the
 *   recipient's address; only the error, response codes and SMTP command are kept.
 */
function serializeError(err: Error): Fields {
  const e = err as ErrorFields;
  if (typeof e.query === "string" && "params" in e) {
    const cause = e.cause instanceof Error ? (e.cause as ErrorFields) : undefined;
    return {
      name: "DrizzleQueryError",
      query: e.query,
      cause: cause ? { name: cause.name, code: cause.code, message: cause.message } : undefined,
    };
  }
  if ("responseCode" in e || "command" in e) {
    return { name: e.name, code: e.code, responseCode: e.responseCode, command: e.command };
  }
  return { name: e.name, code: e.code, message: e.message, stack: e.stack };
}

export const log = {
  debug: (fields: Fields, event: string) => write("debug", fields, event),
  info: (fields: Fields, event: string) => write("info", fields, event),
  warn: (fields: Fields, event: string) => write("warn", fields, event),
  error: (fields: Fields, event: string) => write("error", fields, event),
};
