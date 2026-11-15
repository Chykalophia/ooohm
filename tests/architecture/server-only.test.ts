import assert from "node:assert/strict";
import { test } from "node:test";
import { listFiles, read } from "./files";

/**
 * F5 (docs/architecture-plan/04-fitness-functions.md): every server file imports
 * `server-only`, so the build fails if client code ever pulls one in.
 *
 * Files under src/lib that client components import, and so cannot be server-only.
 * Each is checked by the client-boundary rules instead.
 */
const CLIENT_SAFE = new Set(["src/lib/auth-client.ts", "src/lib/color.ts", "src/lib/format.ts"]);

/**
 * Server files that tools outside the react-server condition load. drizzle-kit reads
 * the schema with its own loader (`pnpm db:generate`), so it cannot import server-only.
 */
const LOADED_OUTSIDE_NEXT = new Set(["src/db/schema.ts"]);

/** Shared server code outside src/shared/lib/db: the unit of work and the admin checks. */
const SHARED_SERVER_FILES = ["src/shared/lib/unit-of-work.ts", "src/shared/lib/admin-access.ts"];

/** A module's application, infrastructure and index.ts run on the server; its domain and ui may not. */
const isModuleServerFile = (path: string) => /^src\/modules\/[^/]+\/(application\/|infrastructure\/|index\.ts$)/.test(path);

function serverFiles(): string[] {
  return ["src/server", "src/db", "src/lib", "src/shared/lib/db"]
    .flatMap((dir) => listFiles(dir, /\.tsx?$/))
    .concat(listFiles("src/modules", /\.tsx?$/).filter(isModuleServerFile))
    .concat(SHARED_SERVER_FILES)
    .filter((path) => !CLIENT_SAFE.has(path) && !LOADED_OUTSIDE_NEXT.has(path) && !path.endsWith(".d.ts"));
}

const importsServerOnly = (source: string) => /^import\s+["']server-only["'];?$/m.test(source);

test("every server file imports server-only", () => {
  const missing = serverFiles().filter((path) => !importsServerOnly(read(path)));
  assert.deepEqual(missing, [], `Add import "server-only" to these server files:\n${missing.join("\n")}`);
});
