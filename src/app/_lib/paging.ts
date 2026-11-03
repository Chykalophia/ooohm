import { z } from "zod";
import type { PageCursor, Paged } from "@/domain/paging";
import type { PagerLinks } from "@/components/navigation/pager";
import { readParam } from "./calendar-input";

type SearchParams = Record<string, string | string[] | undefined>;

const tokenSchema = z
  .string()
  .max(4_000)
  .regex(/^[A-Za-z0-9_-]+$/);
const numberSchema = z.string().regex(/^[1-9]\d{0,5}$/);

/** Which page a long list's link asks for. */
export interface PageParams {
  /** `?after=` or `?before=`; the first page when neither (or both) is there. */
  cursor: PageCursor | undefined;
  /** `?page=`, the position the links counted; 1 on the first page. */
  number: number;
}

export function readPageParams(params: SearchParams): PageParams {
  const after = readParam(tokenSchema, params.after);
  const before = readParam(tokenSchema, params.before);
  const cursor: PageCursor | undefined =
    after && !before ? { direction: "after", token: after } : before && !after ? { direction: "before", token: before } : undefined;
  const number = cursor ? Number(readParam(numberSchema, params.page) ?? 2) : 1;
  return { cursor, number };
}

/**
 * A link to a list at `path` with `params` in its query (empty values dropped) and
 * `#fragment` when given: how a list's filter, sort and page links are built.
 */
export function listHref(path: string, params: Record<string, string | undefined>, fragment?: string): string {
  const query = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => Boolean(e[1]))).toString();
  return `${path}${query ? `?${query}` : ""}${fragment ? `#${fragment}` : ""}`;
}

/**
 * The {@link Pager}'s links for one page of a list at `path`. Each keeps `keep` (the
 * list's filters and view, empty values dropped) and ends in `#fragment` when given, so
 * a list lower down the page stays in view.
 */
export function pagerLinks(
  path: string,
  page: Pick<Paged<unknown>, "previous" | "next">,
  number: number,
  { keep = {}, fragment }: { keep?: Record<string, string | undefined>; fragment?: string } = {},
): PagerLinks {
  const href = (extra: Record<string, string> = {}) => listHref(path, { ...keep, ...extra }, fragment);
  const at = (cursor: PageCursor, n: number) => href({ [cursor.direction]: cursor.token, page: String(n) });
  // Without a previous page this is page 1, whatever the link said.
  const shown = page.previous ? Math.max(number, 2) : 1;
  return {
    number: shown,
    first: shown > 2 ? href() : null,
    previous: page.previous ? (shown === 2 ? href() : at(page.previous, shown - 1)) : null,
    next: page.next ? at(page.next, shown + 1) : null,
  };
}
