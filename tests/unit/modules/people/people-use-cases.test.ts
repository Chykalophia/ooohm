import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor } from "@/domain/actor";
import type { ServiceContext } from "@/server/context";
import { getDeletionPreview } from "@/modules/people/application/queries/get-deletion-preview";
import { getPersonDetail } from "@/modules/people/application/queries/get-person-detail";
import { getPersonFormOptions } from "@/modules/people/application/queries/get-person-form-options";
import { getTeamMember } from "@/modules/people/application/queries/get-team-member";
import { listPeople } from "@/modules/people/application/queries/list-people";
import { previewPeopleImport } from "@/modules/people/application/queries/preview-people-import";
import { cancelScheduledDeletion } from "@/modules/people/application/use-cases/cancel-scheduled-deletion";
import { deactivatePerson } from "@/modules/people/application/use-cases/deactivate-person";
import { deletePerson } from "@/modules/people/application/use-cases/delete-person";
import { exportPersonRecords } from "@/modules/people/application/use-cases/export-person-records";
import { importPeople } from "@/modules/people/application/use-cases/import-people";
import { invitePerson } from "@/modules/people/application/use-cases/invite-person";
import { reactivatePerson } from "@/modules/people/application/use-cases/reactivate-person";
import { resendInvite } from "@/modules/people/application/use-cases/resend-invite";
import { updatePerson } from "@/modules/people/application/use-cases/update-person";

/**
 * Each admin use case refuses anyone but an admin with `forbidden` before it reads or
 * writes anything: the context here has no database, so any query would throw.
 */
const ctx = new Proxy({}, { get: (_t, key) => { throw new Error(`touched ctx.${String(key)}`); } }) as ServiceContext;
const actor = (role: Actor["role"]): Actor => ({ id: "u-1", companyId: "co-1", role, canSelfApprove: false, source: { kind: "user", userId: "u-1" } });
const ID = "3f9a2c71-0b8e-4f4e-9d1c-2a7b6e5d4c3b";
const fields = { name: "Ana", departmentId: null, managerId: null, role: "employee", canSelfApprove: false };

const calls: Record<string, (a: Actor) => Promise<{ ok: boolean; error?: { code: string } }>> = {
  listPeople: (a) => listPeople(ctx, a, { status: "active" }),
  getPersonFormOptions: (a) => getPersonFormOptions(ctx, a, null),
  getPersonDetail: (a) => getPersonDetail(ctx, a, ID),
  invitePerson: (a) => invitePerson(ctx, a, { email: "ana@acme.test", ...fields }),
  resendInvite: (a) => resendInvite(ctx, a, ID),
  updatePerson: (a) => updatePerson(ctx, a, ID, fields),
  deactivatePerson: (a) => deactivatePerson(ctx, a, ID),
  reactivatePerson: (a) => reactivatePerson(ctx, a, ID),
  getDeletionPreview: (a) => getDeletionPreview(ctx, a, ID),
  deletePerson: (a) => deletePerson(ctx, a, ID, { mode: "scrubbed", confirmName: "Ana" }),
  cancelScheduledDeletion: (a) => cancelScheduledDeletion(ctx, a, ID),
  exportPersonRecords: (a) => exportPersonRecords(ctx, a, ID),
  previewPeopleImport: (a) => previewPeopleImport(ctx, a, "email,name\n"),
  importPeople: (a) => importPeople(ctx, a, { csv: "email,name\n", sendInvites: false }),
};

describe("people use cases refuse non-admins first", () => {
  for (const [name, call] of Object.entries(calls)) {
    test(name, async () => {
      for (const role of ["employee", "manager"] as const) {
        const result = await call(actor(role));
        assert.equal(result.ok, false);
        assert.equal(result.error?.code, "forbidden");
      }
    });
  }
});

describe("input that can never match is refused before any read", () => {
  test("deleting with an unknown mode is invalid_input", async () => {
    const result = await deletePerson(ctx, actor("admin"), ID, { mode: "shred", confirmName: "Ana" });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, "invalid_input");
  });

  test("a Team page for an id that is not a uuid is not_found", async () => {
    const result = await getTeamMember(ctx, actor("employee"), "not-a-uuid");
    assert.equal(!result.ok && result.error.code, "not_found");
  });
});
