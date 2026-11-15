import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canDeletePeople, canImportPeople, canManagePeople } from "@/modules/people/application/policies";
import { ROLES } from "@/domain/actor";

/** Only admins manage, delete and import people; every other role is refused before any read. */
describe("people policies", () => {
  for (const [name, policy] of Object.entries({ canManagePeople, canDeletePeople, canImportPeople })) {
    test(`${name}: admins only`, () => {
      for (const role of ROLES) assert.equal(policy({ role }), role === "admin", role);
    });
  }
});
