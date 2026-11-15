import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { toPasskeyDTO, toPersonDTO, toPersonListItemDTO } from "@/modules/people/application/dto";
import type { PersonRow } from "@/shared/lib/db/members";

/**
 * What leaves the people module. Each mapper copies exactly the listed fields, so a row
 * that a query reads with more (a sort key, a deletion mode, a passkey's backup flag)
 * never hands it on. The email is in a person's DTO because only the admin screens and
 * the person's own account page get one.
 */
const row: PersonRow = {
  id: "u-1",
  name: "Ana Lima",
  email: "ana@acme.test",
  role: "employee",
  departmentId: "d-1",
  levelId: null,
  managerId: "u-2",
  canSelfApprove: false,
  isActive: true,
  createdAt: new Date("2026-01-05T09:00:00Z"),
  scrubScheduledAt: null,
};

describe("people DTOs", () => {
  test("a person copies the admin fields and nothing else", () => {
    const extra = { ...row, sortName: "ana lima", deletionMode: null, companyId: "c-1" } as PersonRow;
    assert.deepEqual(Object.keys(toPersonDTO(extra)).sort(), [
      "canSelfApprove",
      "createdAt",
      "departmentId",
      "email",
      "id",
      "isActive",
      "levelId",
      "managerId",
      "name",
      "role",
      "scrubScheduledAt",
    ]);
    assert.deepEqual(toPersonDTO(extra), row);
  });

  test("a list row adds the department's and manager's names, not the sort key", () => {
    const listed = toPersonListItemDTO({ ...row, sortName: "ana lima", departmentName: "Ops", managerName: "Bo", managerEmail: "bo@acme.test" } as never);
    assert.equal("sortName" in listed, false);
    assert.deepEqual({ ...listed }, { ...row, departmentName: "Ops", managerName: "Bo", managerEmail: "bo@acme.test" });
  });

  test("a passkey names itself and says whether it syncs, never its key or backup flag", () => {
    const dto = toPasskeyDTO({ id: "p-1", name: "Laptop", createdAt: null, deviceType: "multiDevice", backedUp: true, publicKey: "secret" } as never);
    assert.deepEqual(dto, { id: "p-1", name: "Laptop", createdAt: null, synced: true });
    assert.equal(toPasskeyDTO({ id: "p-2", name: null, createdAt: null, deviceType: "singleDevice" }).synced, false);
  });
});
