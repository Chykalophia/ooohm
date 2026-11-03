// Signs a Playwright context in as a demo person through the real magic-link flow,
// reading the one-time token from the local database instead of an inbox. Sessions are
// kept in .auth/ so repeated runs stay under the sign-in rate limit.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BASE = process.env.DEMO_URL ?? "http://localhost:3000";
const DB = process.env.DATABASE_URL ?? "postgres://ooohm:ooohm@127.0.0.1:5432/ooohm";
const EMBEDDED = DB.startsWith("pglite:") || process.env.OOOHM_DB === "embedded";
// The token is read straight from the database, so only ever point this at a local one.
const url = EMBEDDED ? null : new URL(DB);
if (url && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("The demo recorder only runs against a local database.");
// psql gets the password through its environment, so it never shows up in the process list.
const PGPASSWORD = url ? decodeURIComponent(url.password) : "";
if (url) url.password = "";
const PSQL_URL = url?.toString();
const AUTH = join(dirname(fileURLToPath(import.meta.url)), ".auth");

/** A new context signed in as `email`. */
export async function signedInContext(browser, email, options = {}) {
  const state = join(AUTH, `${email}.json`);
  if (existsSync(state)) {
    const ctx = await browser.newContext({ ...options, storageState: state });
    const res = await ctx.request.get(`${BASE}/api/auth/get-session`);
    if (res.ok() && (await res.json())?.user) return ctx;
    await ctx.close();
  }
  const ctx = await browser.newContext(options);
  try {
    await signIn(ctx, email, state);
    return ctx;
  } catch (e) {
    await ctx.close();
    throw e;
  }
}

async function signIn(ctx, email, state) {
  const res = await ctx.request.post(`${BASE}/api/auth/sign-in/magic-link`, {
    headers: { origin: BASE },
    data: { email, callbackURL: "/" },
  });
  if (!res.ok()) throw new Error(`magic link request failed: ${res.status()}`);
  if (EMBEDDED) {
    throw new Error("Signing in for a recording reads the token with psql, so it needs Postgres, not embedded PGlite.");
  }
  const id = execFileSync("psql", [PSQL_URL, "-At", "-v", `email=${email}`], {
    env: { ...process.env, ...(PGPASSWORD ? { PGPASSWORD } : {}) },
    input: "select identifier from verification where value::jsonb ->> 'email' = :'email' order by created_at desc limit 1;",
  }).toString().trim();
  if (!id) throw new Error(`no magic-link token for ${email}; is ${email} a member, and is DATABASE_URL the app's database?`);
  await ctx.request.get(`${BASE}/api/auth/magic-link/verify?token=${encodeURIComponent(id.replace(/^magic-link:/, ""))}&callbackURL=/`, { maxRedirects: 0 });
  const check = await ctx.request.get(`${BASE}/api/auth/get-session`);
  if (!check.ok() || !(await check.json())?.user) throw new Error(`signing in as ${email} failed (get-session ${check.status()})`);
  mkdirSync(AUTH, { recursive: true });
  await ctx.storageState({ path: state });
}
