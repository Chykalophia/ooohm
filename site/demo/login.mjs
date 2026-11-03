// Signs a Playwright context in as a demo person through the real magic-link flow,
// reading the one-time token from the local database instead of an inbox. Sessions are
// kept in .auth/ so repeated runs stay under the sign-in rate limit.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BASE = process.env.DEMO_URL ?? "http://localhost:3000";
const DB = process.env.DATABASE_URL ?? "postgres://ooohm:ooohm@127.0.0.1:5432/ooohm";
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
  const res = await ctx.request.post(`${BASE}/api/auth/sign-in/magic-link`, {
    headers: { origin: BASE },
    data: { email, callbackURL: "/" },
  });
  if (!res.ok()) throw new Error(`magic link request failed: ${res.status()}`);
  const id = execFileSync("psql", [DB, "-Atc", `select identifier from verification where value like '%"${email}"%' order by created_at desc limit 1`]).toString().trim();
  await ctx.request.get(`${BASE}/api/auth/magic-link/verify?token=${id.replace(/^magic-link:/, "")}&callbackURL=/`, { maxRedirects: 0 });
  mkdirSync(AUTH, { recursive: true });
  await ctx.storageState({ path: state });
  return ctx;
}
