import assert from "node:assert/strict";
import { test } from "node:test";
import { listFiles, read } from "./files";

/**
 * Nearly every module reads organisation (the company, departments, levels, leave types),
 * so organisation imports no other module and none of the old services: any such import
 * would become a cycle as soon as that code is a module. A change that reaches into leave,
 * approvals or email (the working-days recount, re-routing approvals) joins organisation's
 * step with that work outside it (`src/server/services/company-settings.ts`,
 * `department-manager.ts`).
 */
test("the organisation module imports no other module and no old service", () => {
  const offending = listFiles("src/modules/organisation", /\.ts$/).flatMap((path) =>
    [...read(path).matchAll(/from "(@\/modules\/(?!organisation[/"])[^"]*|@\/server\/services\/[^"]*)"/g)].map((m) => `${path}: ${m[1]}`),
  );
  assert.deepEqual(offending, []);
});
