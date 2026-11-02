/**
 * Where a webhook may be sent: the URL rules applied when an admin saves an endpoint,
 * and the address rules applied to every address a host name resolves to when a
 * delivery connects (server-side request forgery protection). Pure: the worker's
 * transport does the DNS lookups and calls {@link isBlockedAddress} on each answer.
 */
import { DomainError } from "./errors";

/** Mirrors `WEBHOOK_ALLOW_INSECURE` and `WEBHOOK_ALLOW_PRIVATE`; both off in production. */
export interface TargetPolicy {
  /** Allow `http://` URLs (local development only). */
  allowInsecure: boolean;
  /** Allow loopback, private, link-local and other non-public addresses (local development only). */
  allowPrivate: boolean;
}

export const STRICT_TARGET_POLICY: TargetPolicy = { allowInsecure: false, allowPrivate: false };

export const WEBHOOK_URL_MAX_LENGTH = 2048;

/* ------------------------------------------------------------------ */
/* Addresses                                                          */
/* ------------------------------------------------------------------ */

/** The four bytes of a dotted-quad IPv4 address, or `null`. Only the canonical form: no octal, hex or short forms. */
export function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

/**
 * The sixteen bytes of an IPv6 address, or `null`. Accepts `::` compression and a
 * trailing dotted IPv4 part (`::ffff:127.0.0.1`); refuses zone ids (`fe80::1%eth0`).
 */
export function parseIpv6(value: string): number[] | null {
  if (value.includes("%") || !/^[0-9a-fA-F:.]+$/.test(value)) return null;
  let head = value;
  let tailBytes: number[] = [];
  const lastColon = value.lastIndexOf(":");
  if (value.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(value.slice(lastColon + 1));
    if (!v4) return null;
    tailBytes = v4;
    head = value.slice(0, lastColon + 1);
    // "::1.2.3.4" leaves "::", "a::1.2.3.4" leaves "a::"; "a:1.2.3.4" leaves "a:", which needs its group back.
    if (head.endsWith(":") && !head.endsWith("::")) head = head.slice(0, -1);
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const groups = (s: string) => (s === "" ? [] : s.split(":"));
  const left = groups(halves[0]);
  const right = halves.length === 2 ? groups(halves[1]) : [];
  const wanted = 8 - tailBytes.length / 2;
  const present = left.length + right.length;
  if (halves.length === 1 ? present !== wanted : present >= wanted) return null;
  const all = [...left, ...Array<string>(wanted - present).fill("0"), ...right];
  const bytes: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  return [...bytes, ...tailBytes];
}

type Range = { bytes: number[]; prefix: number };

function inRange(addr: readonly number[], range: Range): boolean {
  let bits = range.prefix;
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((addr[i] & mask) !== (range.bytes[i] & mask)) return false;
  }
  return true;
}

function v4(cidr: string): Range {
  const [ip, prefix] = cidr.split("/");
  return { bytes: parseIpv4(ip)!, prefix: Number(prefix) };
}

function v6(cidr: string): Range {
  const [ip, prefix] = cidr.split("/");
  return { bytes: parseIpv6(ip)!, prefix: Number(prefix) };
}

/**
 * IPv4 ranges a webhook may never reach: "this network", private (RFC 1918), shared
 * (CGNAT), loopback, link-local (which holds the cloud metadata service at
 * 169.254.169.254), IETF protocol assignments, documentation, benchmarking, multicast,
 * reserved and broadcast.
 */
const BLOCKED_V4: readonly Range[] = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
].map(v4);

/**
 * IPv6 ranges a webhook may never reach: unspecified, loopback, discard, documentation,
 * Teredo, ORCHID, unique local (which holds AWS's metadata service at fd00:ec2::254),
 * site-local, link-local and multicast. Ranges that embed an IPv4 address are checked
 * through it instead (see {@link embeddedIpv4}).
 */
const BLOCKED_V6: readonly Range[] = [
  "::/128",
  "::1/128",
  "100::/64",
  "2001::/32",
  "2001:10::/28",
  "2001:20::/28",
  "2001:db8::/32",
  "fc00::/7",
  "fec0::/10",
  "fe80::/10",
  "ff00::/8",
].map(v6);

/** IPv6 ranges that carry an IPv4 address, and where it sits. */
const EMBEDS_V4: readonly (Range & { at: number })[] = [
  { ...v6("::ffff:0:0/96"), at: 12 }, // IPv4-mapped
  { ...v6("::/96"), at: 12 }, // IPv4-compatible (deprecated)
  { ...v6("64:ff9b::/96"), at: 12 }, // NAT64
  { ...v6("64:ff9b:1::/48"), at: 12 }, // local-use NAT64
  { ...v6("2002::/16"), at: 2 }, // 6to4
];

/** The IPv4 address inside an IPv4-mapped, -compatible, NAT64 or 6to4 IPv6 address, if any. */
export function embeddedIpv4(bytes: readonly number[]): number[] | null {
  for (const range of EMBEDS_V4) {
    if (inRange(bytes, range)) return bytes.slice(range.at, range.at + 4);
  }
  return null;
}

/**
 * Whether a webhook must not connect to `address` (an IP literal). Anything that does
 * not parse as an address is blocked too, so a caller can never fail open.
 */
export function isBlockedAddress(address: string): boolean {
  const ip = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const four = parseIpv4(ip);
  if (four) return BLOCKED_V4.some((r) => inRange(four, r));
  const six = parseIpv6(ip);
  if (!six) return true;
  const inner = embeddedIpv4(six);
  // "::" and "::1" sit inside the IPv4-compatible range; they are blocked as themselves.
  if (BLOCKED_V6.some((r) => inRange(six, r))) return true;
  if (inner) return BLOCKED_V4.some((r) => inRange(inner, r));
  return false;
}

/** True for an IP literal host (`127.0.0.1`, `[::1]`), as URL parsing leaves it. */
export function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return parseIpv6(hostname.slice(1, -1)) !== null;
  return parseIpv4(hostname) !== null;
}

/* ------------------------------------------------------------------ */
/* URLs                                                               */
/* ------------------------------------------------------------------ */

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

/**
 * The URL an endpoint is saved with, checked against `policy`:
 *
 * - absolute `https://` (or `http://` when `allowInsecure`), at most
 *   {@link WEBHOOK_URL_MAX_LENGTH} characters, no user name or password, no fragment;
 * - unless `allowPrivate`, a host that is not a blocked IP literal (see
 *   {@link isBlockedAddress}) nor an obviously local name (`localhost`, `*.local`,
 *   `*.internal`). Names are resolved, and every answer checked, at each delivery: a
 *   name that is public today can point inside the network tomorrow.
 *
 * @returns The URL in its normalized form (`new URL(...).href`).
 * @throws DomainError `invalid_input` (not a URL, too long, credentials, fragment),
 *   `insecure_url` (not https), or `blocked_address`.
 */
export function normalizeWebhookUrl(raw: string, policy: TargetPolicy): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > WEBHOOK_URL_MAX_LENGTH) throw new DomainError("invalid_input");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new DomainError("invalid_input");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new DomainError("insecure_url");
  if (url.protocol === "http:" && !policy.allowInsecure) throw new DomainError("insecure_url");
  if (url.username || url.password || url.hash || !url.hostname) throw new DomainError("invalid_input");
  if (!policy.allowPrivate) {
    const host = url.hostname;
    if (isIpLiteral(host) ? isBlockedAddress(host) : LOCAL_NAMES.test(host.replace(/\.$/, "")) || !host.includes(".")) {
      throw new DomainError("blocked_address");
    }
  }
  if (url.href.length > WEBHOOK_URL_MAX_LENGTH) throw new DomainError("invalid_input");
  return url.href;
}

/** `https://example.com` for an endpoint URL: what audit rows and events carry, since paths often hold tokens. */
export function urlOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}
