import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT, read } from "./files";

/**
 * Every server file imports `server-only`, which throws unless the `react-server`
 * condition is set. Next.js sets it on the server; every `tsx` command that loads
 * src/ must set it too, or adding the import would break migrate, seed and the build.
 */
const scripts: Record<string, string> = JSON.parse(read("package.json")).scripts;

test("every tsx command in package.json runs with --conditions=react-server", () => {
  const missing = Object.entries(scripts).flatMap(([name, command]) =>
    command
      .split("&&")
      .map((part) => part.trim())
      .filter((part) => /^tsx\b/.test(part) && !part.includes("--conditions=react-server"))
      .map((part) => `${name}: ${part}`),
  );
  assert.deepEqual(missing, []);
});

test("the Vercel build's migrate and seed steps load every module they import", () => {
  const tsx = join(ROOT, "node_modules", ".bin", "tsx");
  const env = { ...process.env, VERCEL_ENV: "preview", OOOHM_DB: "embedded" };
  for (const script of ["scripts/migrate.mts", "scripts/seed.mts"]) {
    // With VERCEL_ENV other than production both exit before touching a database, after
    // their static imports (src/db, the schema, the domain) have all loaded.
    const out = execFileSync(tsx, ["--conditions=react-server", script, "--if-production"], { cwd: ROOT, env, encoding: "utf8" });
    assert.match(out, /Skipping/, script);
  }
});
