import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./files";

/** `pnpm db:check-drift` (ADR-0011): src/db/schema.ts and drizzle/ never disagree. */

function checkDrift(...args: string[]) {
  return spawnSync(join(ROOT, "node_modules", ".bin", "tsx"), ["--conditions=react-server", "scripts/check-drift.mts", ...args], { cwd: ROOT, encoding: "utf8" });
}

test("the committed migrations make exactly src/db/schema.ts", () => {
  const run = checkDrift();
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /No drift/);
});

test("the check fails, showing the SQL, when the last migration is missing", () => {
  const stale = mkdtempSync(join(tmpdir(), "ooohm-stale-migrations-"));
  try {
    cpSync(join(ROOT, "drizzle"), stale, { recursive: true });
    const journalPath = join(stale, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
    // The newest migrations are a column (0029), SQL functions only (0030), row-level
    // security only (0031) and its review fixes (0032): drop all four.
    const dropped = journal.entries.splice(-4);
    for (const { tag } of dropped) {
      rmSync(join(stale, `${tag}.sql`));
      rmSync(join(stale, "meta", `${tag.slice(0, 4)}_snapshot.json`));
    }
    writeFileSync(journalPath, JSON.stringify(journal));
    const run = checkDrift("--migrations", stale);
    assert.equal(run.status, 1, run.stderr || run.stdout);
    assert.match(run.stderr, /Schema drift/);
    assert.match(run.stderr, /ALTER TABLE "departments" ADD COLUMN "max_off"/);
  } finally {
    rmSync(stale, { recursive: true, force: true });
  }
});
