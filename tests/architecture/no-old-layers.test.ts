import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { listFiles, read, ROOT } from "./files";

/**
 * Use cases live in a module's `application/` and queries in its `infrastructure/` or in
 * `src/shared/lib/db/` (ADR-0009); pure rules live in a module's `domain/` or, when several
 * layers share them, in `src/shared/kernel/`. The old `src/server/services`,
 * `src/server/repositories` and `src/domain` folders are gone, and nothing may bring them
 * back or import them.
 */
const OLD = ["src/server/services", "src/server/repositories", "src/domain"];

test("src/server/services, src/server/repositories and src/domain do not exist", () => {
  assert.deepEqual(
    OLD.filter((dir) => existsSync(join(ROOT, dir))),
    [],
    "put a use case in its module's application/, a query in its infrastructure/ or src/shared/lib/db/, and a pure rule in its module's domain/ or src/shared/kernel/",
  );
});

test("nothing imports the old services, repositories or domain", () => {
  const offending = ["src", "tests", "scripts"].flatMap((dir) =>
    listFiles(dir, /\.(ts|tsx|mts)$/).filter((path) => /from "@\/(server\/(services|repositories)|domain)\//.test(read(path))),
  );
  assert.deepEqual(offending, []);
});
