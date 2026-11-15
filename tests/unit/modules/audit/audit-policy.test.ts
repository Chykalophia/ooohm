import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor } from "@/domain/actor";
import { isDomainError } from "@/domain/errors";
import { canViewAuditLog, getAuditLog, listAuditEntriesAbout } from "@/modules/audit";
import type { ServiceContext } from "@/server/context";

const actor = (role: Actor["role"]): Actor => ({ id: "u-1", companyId: "co-1", role, canSelfApprove: false, source: { kind: "user", userId: "u-1" } });

/** A context whose every port throws: a refusal must come before any read. */
const untouchable = new Proxy({} as ServiceContext, {
  get(_target, port) {
    throw new Error(`the policy check came after ctx.${String(port)}`);
  },
});

describe("canViewAuditLog", () => {
  test("admins read their company's audit log", () => {
    assert.equal(canViewAuditLog({ role: "admin" }), true);
  });

  test("managers and employees do not", () => {
    assert.equal(canViewAuditLog({ role: "manager" }), false);
    assert.equal(canViewAuditLog({ role: "employee" }), false);
  });
});

describe("the audit queries refuse non-admins before they read anything", () => {
  for (const role of ["manager", "employee"] as const) {
    test(role, async () => {
      const result = await getAuditLog(untouchable, actor(role), {});
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.error.code, "forbidden");
      await assert.rejects(listAuditEntriesAbout(untouchable, actor(role), "u-2", 10), (e) => isDomainError(e, "forbidden"));
    });
  }
});
