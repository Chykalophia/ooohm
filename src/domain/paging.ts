/**
 * Keyset pagination for every long list: the audit log, people, requests, approvals and
 * webhook deliveries. A page starts just after (or ends just before) one row's sort key,
 * so each page is one indexed read of `size + 1` rows however deep someone browses, and
 * rows written meanwhile are never skipped or shown twice (an offset would do both).
 *
 * A cursor is the sort key of the row at the page's edge, as an opaque URL-safe token.
 * Tokens come back from links anyone can edit, so each list checks every part before
 * using it; anything else reads as the first page.
 */

/** `after`: the rows that follow the key (the next page). `before`: those that come just before it (the previous page). */
export type PageDirection = "after" | "before";

/** Where a page starts, as it travels in a link (`?after=…` or `?before=…`). */
export interface PageCursor {
  direction: PageDirection;
  token: string;
}

/** A decoded cursor: one string per sort column, checked. */
export interface PageRequest {
  direction: PageDirection;
  key: string[];
}

/** One page of a list, with the cursors to the pages on either side (`null` at either end). */
export interface Paged<T> {
  items: T[];
  previous: PageCursor | null;
  next: PageCursor | null;
}

/** Checks one part of a key: the right shape for its column (a uuid, a date, an instant). */
export type KeyPartCheck = (part: string) => boolean;

/** The longest token accepted, so a pasted megabyte is refused before it is decoded. */
const MAX_TOKEN_LENGTH = 4_000;

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(token: string): string | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(token)) return undefined;
  try {
    const binary = atob(token.replaceAll("-", "+").replaceAll("_", "/"));
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

export function encodePageKey(key: readonly string[]): string {
  return toBase64Url(JSON.stringify(key));
}

/**
 * The key in `token`, or `undefined` unless it has exactly one string per check and
 * each passes its check.
 */
export function decodePageKey(token: string, checks: readonly KeyPartCheck[]): string[] | undefined {
  if (token.length > MAX_TOKEN_LENGTH) return undefined;
  const json = fromBase64Url(token);
  if (json === undefined) return undefined;
  let key: unknown;
  try {
    key = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!Array.isArray(key) || key.length !== checks.length) return undefined;
  if (!key.every((part, i) => typeof part === "string" && checks[i](part))) return undefined;
  return key as string[];
}

/** A text key part: any string up to `max` characters (a lowercased name, an email). */
export const textPart =
  (max: number): KeyPartCheck =>
  (part) =>
    part.length <= max;

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z$/;

/**
 * An instant as the repositories print it for cursors: UTC to the microsecond,
 * `YYYY-MM-DDTHH:MM:SS.ffffffZ`. It must be a real instant, not just the right shape:
 * Postgres refuses `2026-02-30`, which would turn a forged link into an error page.
 */
export function isCursorInstant(part: string): boolean {
  const m = INSTANT.exec(part);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d && h <= 23 && mi <= 59 && s <= 59;
}

/**
 * Reads one page of a list, given how to read its rows and how to key them. Pass `read`
 * before `keyOf`: TypeScript infers the row type from it, left to right.
 */
export interface PageSource<T> {
  /** The cursor from the link, if any. One that does not decode reads as the first page. */
  cursor: PageCursor | undefined;
  size: number;
  /** One check per sort column, in order. */
  checks: readonly KeyPartCheck[];
  /** A row's sort key, one string per column, as the checks expect. */
  keyOf: (row: T) => readonly string[];
  /**
   * Up to `limit` rows: from the start of the list without a request; otherwise the rows
   * following `key` (`after`, in list order) or preceding it (`before`, nearest first,
   * so in reverse list order).
   */
  read: (request: PageRequest | undefined, limit: number) => Promise<T[]>;
}

/**
 * One page, in list order, and the cursors either side. One read of `size + 1` rows (the
 * extra row only tells whether there is more), except when "previous" reaches the start
 * of the list with less than a page left: that reads the first page instead, so the
 * first page always looks the same however someone got there.
 */
export async function readPage<T>({ cursor, size, checks, keyOf, read }: PageSource<T>): Promise<Paged<T>> {
  const key = cursor ? decodePageKey(cursor.token, checks) : undefined;
  let request: PageRequest | undefined = cursor && key ? { direction: cursor.direction, key } : undefined;
  let rows = await read(request, size + 1);
  if (request?.direction === "before" && rows.length <= size) {
    request = undefined;
    rows = await read(undefined, size + 1);
  }
  const at = (direction: PageDirection, k: readonly string[]): PageCursor => ({ direction, token: encodePageKey(k) });

  if (request?.direction === "before") {
    const items = rows.slice(0, size).reverse();
    return {
      items,
      previous: rows.length > size ? at("before", keyOf(items[0])) : null,
      next: at("after", keyOf(items[items.length - 1])),
    };
  }
  const items = rows.slice(0, size);
  // Past the end (the last rows were removed, or a forged key): "previous" leads back from the key itself.
  const previous = request ? at("before", items.length > 0 ? keyOf(items[0]) : request.key) : null;
  return { items, previous, next: rows.length > size ? at("after", keyOf(items[items.length - 1])) : null };
}
