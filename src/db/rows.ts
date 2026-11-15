import "server-only";
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
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/**
 * The one row a statement always returns: an insert's `RETURNING`, an update's of a row
 * its caller found or locked earlier in the same transaction, or a select of counts. None
 * means that invariant broke, so this throws rather than hand back `undefined` as a row.
 */
export function returnedRow<T>(rows: readonly T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error("The statement returned no row.");
  return row;
}
