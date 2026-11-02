/**
 * Whether a request was started by another site, by its `Sec-Fetch-Site` header: anything
 * other than `same-origin` (OOOhm's own pages) or `none` (typed, bookmarked or opened by
 * the person directly). Browsers too old to send the header are let through; a route that
 * refuses cross-site requests still relies on the session for who is asking.
 *
 * For GET route handlers that change something or hand out personal data, which do not
 * get the origin check Next.js applies to server actions.
 */
export function isCrossSiteRequest(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site");
  return site !== null && site !== "same-origin" && site !== "none";
}
