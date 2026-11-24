import type { SQL } from "drizzle-orm";
import type { Executor } from "./types";

/**
 * Runs a raw statement and returns its rows, whichever driver is behind `ex`: postgres.js
 * returns the rows as an array, PGlite as `{ rows }`. For the few statements the query
 * builder cannot express (an `UPDATE ... FROM` claim with `SKIP LOCKED`). Column names
 * come back as written in the SQL, and values as the driver parses them, so cast
 * numbers with `Number()` rather than relying on one driver's choice.
 */
export async function executeRows<T extends Record<string, unknown>>(ex: Executor, query: SQL): Promise<T[]> {
  const result: unknown = await ex.execute(query);
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  // Anything else is a driver this file doesn't know: an empty answer would hide it.
  if (!Array.isArray(rows)) throw new Error("executeRows: the driver returned neither rows nor { rows }.");
  return rows as T[];
}
