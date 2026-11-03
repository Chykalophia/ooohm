import { type AnyColumn, type SQL, asc, desc, sql } from "drizzle-orm";
import type { PageRequest } from "@/domain/paging";

/**
 * The `where` and `order by` of one keyset page (see `@/domain/paging`): the rows after
 * the key in list order, or the rows before it nearest first. `values` are the key's
 * parts as SQL, cast to their columns' types (`::timestamptz`, `::uuid`).
 *
 * Every column sorts the same way, so one row comparison, `(a, b) < ($1, $2)`, selects
 * the page and an index on the same columns serves it in order.
 */
export function keysetPage(
  order: "asc" | "desc",
  columns: readonly (AnyColumn | SQL)[],
  request: PageRequest | undefined,
  values: (key: string[]) => SQL[],
): { where: SQL | undefined; orderBy: SQL[] } {
  const ascending = (order === "asc") !== (request?.direction === "before");
  const where = request
    ? sql`(${sql.join([...columns], sql`, `)}) ${ascending ? sql`>` : sql`<`} (${sql.join(values(request.key), sql`, `)})`
    : undefined;
  return { where, orderBy: columns.map((c) => (ascending ? asc(c) : desc(c))) };
}

/**
 * An instant printed for a cursor: UTC to the microsecond. A JS `Date` keeps only
 * milliseconds, which would skip or repeat rows written within the same one.
 */
export function cursorInstant(column: AnyColumn): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
