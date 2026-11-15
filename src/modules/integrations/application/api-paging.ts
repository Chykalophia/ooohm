import "server-only";
/**
 * The REST API's pages: an opaque cursor (base64url JSON) and the `{ data, nextCursor }`
 * shape every list endpoint returns. The leave module's API list uses them too.
 */
import { DomainError } from "@/domain/errors";

/** A page of a list, and the opaque cursor of the next one (`null` on the last page). */
export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

function encodeCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** @throws DomainError `invalid_input` for a cursor the API did not make. */
export function decodeCursor<K extends string>(cursor: string, keys: readonly K[]): Record<K, string> {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (value && typeof value === "object" && keys.every((k) => typeof (value as Record<string, unknown>)[k] === "string")) {
      return value as Record<K, string>;
    }
  } catch {
    // Falls through to the error below.
  }
  throw new DomainError("invalid_input", "That cursor is not valid.");
}

/** The first `limit` of `rows` (which holds one more when there is a next page), mapped, with the next page's cursor. */
export function page<R, T>(rows: readonly R[], limit: number, map: (row: R) => T, cursorOf: (row: R) => Record<string, string>): Page<T> {
  const more = rows.length > limit;
  const shown = more ? rows.slice(0, limit) : rows;
  return { data: shown.map(map), nextCursor: more ? encodeCursor(cursorOf(shown[shown.length - 1])) : null };
}

export const iso = (d: Date | null) => (d ? d.toISOString() : null);
