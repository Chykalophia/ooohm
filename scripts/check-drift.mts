/**
 * Schema drift check (ADR-0011): fails when `src/db/schema.ts` and the committed
 * migrations in `drizzle/` disagree, i.e. when `pnpm db:generate` would write a new
 * migration. It runs drizzle-kit against a scratch copy of the migrations folder, so the
 * working tree is never touched, and it never connects to a database.
 *
 *   pnpm db:check-drift                       # the repository's drizzle/
 *   pnpm db:check-drift -- --migrations <dir> # another folder (the check's own test uses this)
 *
 * Exit codes: 0 no drift, 1 drift (the SQL db:generate would write is printed), 2 the
 * check itself could not run. drizzle-kit exits 0 even when it fails, so success is only
 * its "No schema changes" answer.
 *
 * Live drift (a hand edit to a deployed database) is a separate, scheduled check:
 * docs/deploy.md#schema-drift.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = args.indexOf("--migrations");
const source = resolve(ROOT, flag >= 0 ? args[flag + 1] : "drizzle");
const label = flag >= 0 ? source : "drizzle/";

const scratch = mkdtempSync(join(tmpdir(), "ooohm-drift-"));
try {
  cpSync(source, scratch, { recursive: true });
  const before = new Set(readdirSync(scratch));
  // drizzle-kit resolves --out against the working directory, so it gets a relative path.
  const run = spawnSync(
    join(ROOT, "node_modules", ".bin", "drizzle-kit"),
    ["generate", "--dialect", "postgresql", "--casing", "snake_case", "--schema", "./src/db/schema.ts", "--out", relative(ROOT, scratch), "--name", "drift"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
  );
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const added = readdirSync(scratch).filter((f) => f.endsWith(".sql") && !before.has(f));
  if (added.length > 0) {
    console.error(`Schema drift: src/db/schema.ts has changes no migration in ${label} makes. Run \`pnpm db:generate\` and commit drizzle/.`);
    for (const file of added) console.error(`\n-- ${file}: what db:generate would write\n${readFileSync(join(scratch, file), "utf8")}`);
    process.exitCode = 1;
  } else if (run.status === 0 && /No schema changes/i.test(output)) {
    console.log(`No drift: src/db/schema.ts matches the migrations in ${label}.`);
  } else {
    console.error(`The drift check could not run drizzle-kit (status ${run.status ?? run.signal}):\n${output || run.error?.message}`);
    process.exitCode = 2;
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
