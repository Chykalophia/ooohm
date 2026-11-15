import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor } from "@/shared/kernel/actor";
import { canEditEmailCopy, getEmailForAdmin, listEmailsForAdmin, previewEmail, resetEmailCopy, saveEmailCopy } from "@/modules/notifications";
import type { ServiceContext } from "@/server/context";

const actor = (role: Actor["role"]): Actor => ({ id: "u-1", companyId: "co-1", role, canSelfApprove: false, source: { kind: "user", userId: "u-1" } });

/** A context whose every port throws: a refusal must come before any read or write. */
const untouchable = new Proxy({} as ServiceContext, {
  get(_target, port) {
    throw new Error(`the policy check came after ctx.${String(port)}`);
  },
});

describe("canEditEmailCopy", () => {
  test("admins edit their company's email copy", () => {
    assert.equal(canEditEmailCopy({ role: "admin" }), true);
  });

  test("managers and employees do not", () => {
    assert.equal(canEditEmailCopy({ role: "manager" }), false);
    assert.equal(canEditEmailCopy({ role: "employee" }), false);
  });
});

describe("the email editor refuses non-admins before it touches anything", () => {
  const draft = { subject: "Hi", message: "" };
  for (const role of ["manager", "employee"] as const) {
    test(role, async () => {
      const who = actor(role);
      for (const result of [
        await listEmailsForAdmin(untouchable, who),
        await getEmailForAdmin(untouchable, who, "leave.requested"),
        await previewEmail(untouchable, who, "leave.requested", draft),
        await saveEmailCopy(untouchable, who, "leave.requested", draft),
        await resetEmailCopy(untouchable, who, "leave.requested"),
      ]) {
        assert.equal(result.ok, false);
        assert.equal(!result.ok && result.error.code, "forbidden");
      }
    });
  }
});
