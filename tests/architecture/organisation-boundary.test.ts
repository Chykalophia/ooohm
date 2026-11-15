import assert from "node:assert/strict";
import { test } from "node:test";
import { listFiles, read } from "./files";

/**
 * Nearly every module reads organisation (the company, departments, levels, leave types),
 * so organisation imports no other module: any such import would be a cycle. A change
 * that reaches into leave, approvals or email (the working-days recount, re-routing
 * approvals) joins organisation's step with that work in the module that owns it
 * (`updateCompanySettings` in leave, `setDepartmentManager` in approvals).
 */
test("the organisation module imports no other module and no old service", () => {
  const offending = listFiles("src/modules/organisation", /\.ts$/).flatMap((path) =>
    [...read(path).matchAll(/from "(@\/modules\/(?!organisation[/"])[^"]*|@\/server\/services\/[^"]*)"/g)].map((m) => `${path}: ${m[1]}`),
  );
  assert.deepEqual(offending, []);
});
