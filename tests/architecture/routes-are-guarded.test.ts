import assert from "node:assert/strict";
import { test } from "node:test";
import { listFiles, read } from "./files";

/**
 * F7: every route handler authenticates. A route reads the session (`currentUser`),
 * goes through the API handler (`apiGet`, which checks the API key), checks the cron
 * secret, or is on the public list below with the reason it needs no session.
 */
const AUTHENTICATES = /\b(currentUser|requireUser|requireActor|apiGet|handleCronTick)\s*\(/;

const PUBLIC_ROUTES: Record<string, string> = {
  "src/app/api/auth/[...all]/route.ts": "Better Auth's own sign-in endpoints (ADR-0005)",
  "src/app/api/health/route.ts": "health check for load balancers; returns no data",
  "src/app/api/v1/openapi.json/route.ts": "the public API description",
  "src/app/favicon.svg/route.ts": "the company's favicon",
  "src/app/logo/[file]/route.ts": "the company logo, shown on the sign-in page",
  "src/app/api/ics/[file]/route.ts": "calendar feed; the 256-bit token in the URL is the credential",
};

const routes = () => listFiles("src/app", /^route\.tsx?$/);

test("every route handler authenticates or is on the public list", () => {
  const unguarded = routes().filter((path) => !PUBLIC_ROUTES[path] && !AUTHENTICATES.test(read(path)));
  assert.deepEqual(unguarded, [], "Authenticate these routes, or add them to PUBLIC_ROUTES with a reason.");
});

test("every public route still exists", () => {
  const all = new Set(routes());
  assert.deepEqual(Object.keys(PUBLIC_ROUTES).filter((path) => !all.has(path)), []);
});
