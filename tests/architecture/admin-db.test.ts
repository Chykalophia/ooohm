import assert from "node:assert/strict";
import { test } from "node:test";
import { listFiles, read } from "./files";

/**
 * The owner's connection string is read in one place (ADR-0006): src/server/admin/db.ts
 * opens it, and src/db/config.ts, which it calls, validates the record it is handed. No
 * other source file, nor the app's or the worker's env loader, may read it.
 */
/** The source without its comments, which may mention the variable to say where it is read. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("only src/server/admin and src/db/config.ts read DATABASE_ADMIN_URL", () => {
  const allowed = new Set(["src/db/config.ts", "src/server/admin/db.ts"]);
  const reading = listFiles("src", /\.(ts|tsx|mts)$/).filter((file) => !allowed.has(file) && code(read(file)).includes("DATABASE_ADMIN_URL"));
  assert.deepEqual(reading, []);
  assert.ok(code(read("src/server/admin/db.ts")).includes("DATABASE_ADMIN_URL"), "the check sees the one place that does");
});

test("migrate, seed and the TimeOff import open the database through src/server/admin/db.ts", () => {
  for (const script of ["scripts/migrate.mts", "scripts/seed.mts", "scripts/import-timeoff.mts"]) {
    const source = read(script);
    assert.match(source, /from "\.\.\/src\/server\/admin\/db"/, script);
    assert.doesNotMatch(source, /resolveDatabaseConfig|openDatabase\(/, `${script} must not open the app's database`);
  }
});

test("the worker and the rollover job keep the app role's DATABASE_URL", () => {
  for (const script of ["scripts/worker.mts", "scripts/rollover.mts"]) {
    assert.doesNotMatch(read(script), /server\/admin/, script);
  }
});
