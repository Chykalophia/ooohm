import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canManageAppearance, canManageCompanySettings, canManageDepartments, canManageLeaveTypes } from "@/modules/organisation";

/** Who may change how the company is organised: admins only, for each screen in Admin. */
const rules = { canManageCompanySettings, canManageAppearance, canManageDepartments, canManageLeaveTypes };

for (const [name, may] of Object.entries(rules)) {
  describe(name, () => {
    test("admins may", () => {
      assert.equal(may({ role: "admin" }), true);
    });

    test("managers and employees may not", () => {
      assert.equal(may({ role: "manager" }), false);
      assert.equal(may({ role: "employee" }), false);
    });
  });
}
