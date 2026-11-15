import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canManageLevels } from "@/modules/organisation";

describe("canManageLevels", () => {
  test("admins manage their company's levels", () => {
    assert.equal(canManageLevels({ role: "admin" }), true);
  });

  test("managers and employees do not", () => {
    assert.equal(canManageLevels({ role: "manager" }), false);
    assert.equal(canManageLevels({ role: "employee" }), false);
  });
});
