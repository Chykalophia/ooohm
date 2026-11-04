// The demo scripts write to the database directly, so they refuse anything but embedded
// PGlite or a Postgres on this machine. libpq and postgres.js can take the host from the
// URL's authority, from `host` or `hostaddr` in its query, or from PGHOST / PGHOSTADDR, so
// every one of those has to be local, not just the part a URL parser calls the hostname.
const LOCAL = new Set(["localhost", "127.0.0.1", "::1"]);

function isLocalHost(value) {
  const host = value.trim();
  if (host === "" || host.startsWith("/")) return true; // default or a Unix socket
  if (LOCAL.has(host.toLowerCase())) return true; // before port stripping, which would eat ::1's last part
  const name = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.replace(/:\d*$/, "");
  return LOCAL.has(name.toLowerCase());
}

/** True when `url` can only reach a database on this machine. */
export function isLocalDatabase(url, env = process.env) {
  if (!url || url.startsWith("pglite:") || env.OOOHM_DB === "embedded") return true;
  const match = /^postgres(?:ql)?:\/\/(?:[^@/?#]*@)?([^/?#]*)/i.exec(url);
  if (!match) return false;
  let query;
  try {
    query = new URL(url.replace(/^postgres(?:ql)?:\/\/[^/?#]*/i, "postgres://x")).searchParams;
  } catch {
    return false;
  }
  const hosts = [
    ...decodeURIComponent(match[1]).split(","),
    ...query.getAll("host").flatMap((h) => h.split(",")),
    ...query.getAll("hostaddr").flatMap((h) => h.split(",")),
    ...[env.PGHOST, env.PGHOSTADDR].filter(Boolean).flatMap((h) => h.split(",")),
  ];
  return hosts.every(isLocalHost);
}
