import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { ROOT } from "./files";

/**
 * Proves the dependency rules (.dependency-cruiser.cjs) catch what they claim to. The
 * reference warns that a misconfigured cruiser "can scan 0 modules and pass silently",
 * so this plants files that break each rule and checks every one is reported.
 */
const PROBE = "__fitness_probe__";
const probes: Record<string, string> = {
  [`src/domain/${PROBE}/impure.ts`]: `import { eq } from "drizzle-orm";\nexport const probe = eq;\n`,
  [`src/app/${PROBE}/skips-layer.ts`]: `import * as repo from "@/server/repositories/users";\nexport const probe = repo;\n`,
  [`src/components/${PROBE}/reaches-server.ts`]: `import { serviceContext } from "@/server/runtime";\nexport const probe = serviceContext;\n`,
  [`src/lib/${PROBE}/a.ts`]: `import { b } from "./b";\nexport const a = () => b;\n`,
  [`src/lib/${PROBE}/b.ts`]: `import { a } from "./a";\nexport const b = () => a;\n`,
  [`src/lib/${PROBE}/vendor.ts`]: `import nodemailer from "nodemailer";\nexport const probe = nodemailer;\n`,
  [`src/server/services/${PROBE}/concrete.ts`]: `import { env } from "@/lib/env";\nexport const probe = env;\n`,
};

type Cruise = { summary: { totalCruised: number; violations: { rule: { name: string }; from: string; to: string }[] } };

function cruise(paths: string[]): Cruise {
  const bin = join(ROOT, "node_modules", ".bin", "depcruise");
  try {
    return JSON.parse(execFileSync(bin, [...paths, "--config", ".dependency-cruiser.cjs", "--output-type", "json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 }));
  } catch (err) {
    // depcruise exits non-zero when it finds errors; the JSON is still on stdout.
    const stdout = (err as { stdout?: string }).stdout;
    if (stdout) return JSON.parse(stdout);
    throw err;
  }
}

after(() => {
  for (const path of Object.keys(probes)) rmSync(dirname(join(ROOT, path)), { recursive: true, force: true });
});

test("each dependency rule reports a planted violation", () => {
  for (const [path, source] of Object.entries(probes)) {
    mkdirSync(dirname(join(ROOT, path)), { recursive: true });
    writeFileSync(join(ROOT, path), source);
  }
  const { summary } = cruise(Object.keys(probes));
  const fired = (rule: string, from: string) =>
    summary.violations.some((v) => v.rule.name === rule && v.from.includes(`${PROBE}/${from}`));
  assert.ok(fired("domain-is-pure", "impure.ts"), "domain → drizzle-orm not reported");
  assert.ok(fired("app-not-to-infrastructure", "skips-layer.ts"), "app → repository not reported");
  assert.ok(fired("components-not-to-server", "reaches-server.ts"), "component → server not reported");
  assert.ok(fired("no-circular", "a.ts") || fired("no-circular", "b.ts"), "cycle not reported");
  assert.ok(fired("vendor-sdk-only-in-infrastructure", "vendor.ts"), "vendor SDK outside infrastructure not reported");
  assert.ok(fired("application-not-to-concrete-infrastructure", "concrete.ts"), "use case → concrete infrastructure not reported");
});

test("the cruise covers the whole source tree", () => {
  const { summary } = cruise(["src"]);
  assert.ok(summary.totalCruised > 300, `only ${summary.totalCruised} modules cruised`);
});
