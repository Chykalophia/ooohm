import "server-only";

type Level = "info" | "warn" | "error";
type Fields = Record<string, unknown>;

/**
 * Structured JSON-lines logger for server code. `info` goes to stdout,
 * `warn`/`error` to stderr, so log collectors can classify levels.
 */
function write(level: Level, fields: Fields, event: string) {
  // Caller fields go first so they can never overwrite the reserved keys.
  const line = JSON.stringify({ ...serialize(fields), time: new Date().toISOString(), level, event });
  (level === "info" ? process.stdout : process.stderr).write(line + "\n");
}

// Error objects have no enumerable fields, so JSON.stringify would drop them.
function serialize(fields: Fields): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v;
  }
  return out;
}

export const log = {
  info: (fields: Fields, event: string) => write("info", fields, event),
  warn: (fields: Fields, event: string) => write("warn", fields, event),
  error: (fields: Fields, event: string) => write("error", fields, event),
};
