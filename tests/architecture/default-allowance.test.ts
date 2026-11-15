import assert from "node:assert/strict";
import { test } from "node:test";
import { listFiles, read } from "./files";

/**
 * AGENTS.md: every balance reads a person's default allowance through
 * `loadAllowanceDefaults`, never `leaveType.defaultAllowanceDays`, because an allowance
 * rule for their department or level replaces the type's own default. So the field is
 * read only where it is the type's own setting (the catalog, its admin screens, the API
 * and the TimeOff import that write or show it) or where the allowance policy turns it
 * into a person's default. A new reader fails here and has to say which it is.
 */
const ALLOWED: Record<string, string> = {
  "src/db/schema.ts": "the column and its check",
  "src/domain/leave-type-settings.ts": "normalizes the setting an admin enters",
  "src/modules/balances/domain/annual-calendar-year-policy.ts": "the policy, given the person's default by loadAllowanceDefaults",
  "src/modules/balances/domain/allowance-rules.ts": "defaultAllowanceFor and typeDefaults: a rule, else the type's own default",
  "src/modules/balances/domain/rollover.ts": "reads the types after loadAllowanceDefaults replaced their defaults",
  "src/modules/balances/application/member-rollover.ts": "reads the types after loadAllowanceDefaults replaced their defaults",
  "src/server/repositories/leave-type-allowances.ts": "the balance code's read of the setting",
  "src/server/services/api-v1.ts": "the API lists the type's own setting",
  "src/server/services/timeoff-import.ts": "writes the setting from the TimeOff export",
  "src/modules/organisation/": "the leave type catalog, which stores, audits and maps the setting",
  "src/app/admin/leave-types/": "the leave type screens show and edit the setting",
  "src/app/admin/people/[id]/allowances/page.tsx": "shows each person's default, from loadAllowanceDefaults",
};

test("defaultAllowanceDays is read only where it is the type's own setting or the allowance policy", () => {
  const readers = listFiles("src", /\.(ts|tsx)$/).filter((path) => /\.defaultAllowanceDays\b/.test(read(path)));
  assert.ok(readers.length > 0, "no file reads defaultAllowanceDays: the scan is broken");
  const unexpected = readers.filter((path) => !Object.keys(ALLOWED).some((allowed) => (allowed.endsWith("/") ? path.startsWith(allowed) : path === allowed)));
  assert.deepEqual(unexpected, [], "read a person's default through loadAllowanceDefaults (@/modules/balances)");
});
