import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { API_ROUTES_COVERED, API_ROUTES_EXEMPT, COVERED, EXEMPT, TENANCY_SOURCES } from "../support/tenancy-coverage";
import { ROOT } from "./files";

/**
 * The tenant-isolation suite (tests/integration/tenancy.test.ts) must keep up with the
 * code: every function exported by a source in `TENANCY_SOURCES` (module indexes, service,
 * job and identity files, the shared member reads) has a cross-company case there or an
 * exemption with its reason in tests/support/tenancy-coverage.ts.
 */

async function exportedFunctions(): Promise<string[]> {
  const sources: [prefix: string, path: string][] = [];
  const modules = join(ROOT, TENANCY_SOURCES.modules);
  for (const m of readdirSync(modules).sort()) {
    if (existsSync(join(modules, m, "index.ts"))) sources.push([m, join(modules, m, "index.ts")]);
  }
  for (const [prefix, dir] of Object.entries(TENANCY_SOURCES.folders)) {
    for (const f of readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".ts")).sort()) sources.push([`${prefix}/${f.replace(/\.ts$/, "")}`, join(ROOT, dir, f)]);
  }
  for (const [prefix, file] of Object.entries(TENANCY_SOURCES.files)) sources.push([prefix, join(ROOT, file)]);

  const out: string[] = [];
  for (const [prefix, path] of sources) {
    const mod = (await import(path)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) if (typeof value === "function") out.push(`${prefix}:${name}`);
  }
  return out;
}

test("every exported function has a tenancy case or a reasoned exemption", async () => {
  const exported = await exportedFunctions();
  const listed = new Set([...COVERED, ...Object.keys(EXEMPT)]);
  const missing = exported.filter((name) => !listed.has(name));
  assert.deepEqual(missing, [], "add a case to tests/integration/tenancy.test.ts (and COVERED), or an exemption with a reason, for each");
  const stale = [...listed].filter((name) => !exported.includes(name));
  assert.deepEqual(stale, [], "these are listed in tests/support/tenancy-coverage.ts but no longer exported");
});

test("no export is both covered and exempt, and every exemption has a reason", () => {
  const both = COVERED.filter((name) => name in EXEMPT);
  assert.deepEqual(both, []);
  assert.equal(new Set(COVERED).size, COVERED.length, "COVERED lists a name twice");
  for (const [name, reason] of Object.entries(EXEMPT)) assert.ok(reason.trim().length > 10, `${name} needs a reason`);
});

test("every /api/v1 route has a tenancy case or a reasoned exemption", () => {
  const routes = readdirSync(join(ROOT, "src/app/api/v1"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_") && existsSync(join(ROOT, "src/app/api/v1", d.name, "route.ts")))
    .map((d) => d.name)
    .sort();
  assert.deepEqual([...API_ROUTES_COVERED, ...Object.keys(API_ROUTES_EXEMPT)].sort(), routes);
});
