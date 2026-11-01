import { isIP } from "node:net";

/** The one key every caller shares when no trusted proxy names the client. */
export const SHARED_CLIENT = "shared";

/**
 * The address a request came from, as a rate-limit key only (never for authorization).
 *
 * Route handlers do not see the socket. Next's server fills in `X-Forwarded-For` from
 * the socket only when the header is missing and keeps any value the client sent, so
 * the header is the client's to choose unless a proxy in front rewrites it. This trusts
 * it only as far as the operator says: `trustedProxyHops` (`TRUSTED_PROXY_HOPS`) is how
 * many proxies in front of the app each append to `X-Forwarded-For` (or the first one
 * overwrites it). The client is then the entry that many places from the end, which the
 * outermost trusted proxy wrote; anything to its left came from the client.
 *
 * With no trusted proxy (0, the default), a list shorter than the hop count, or an entry
 * that is not an IP address, every caller gets {@link SHARED_CLIENT}. A shared key is
 * coarse but cannot be chosen, rotated or aimed at someone else's address.
 */
export function clientAddress(headers: Headers, trustedProxyHops: number): string {
  if (trustedProxyHops < 1) return SHARED_CLIENT;
  const entries = (headers.get("x-forwarded-for") ?? "").split(",").map((e) => e.trim());
  const entry = entries.length >= trustedProxyHops ? entries[entries.length - trustedProxyHops] : "";
  return entry && isIP(entry) ? entry : SHARED_CLIENT;
}
