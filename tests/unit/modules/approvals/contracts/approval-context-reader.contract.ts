import assert from "node:assert/strict";
import { test } from "node:test";
import type { Role } from "@/shared/kernel/actor";
import type { ApprovalContextReader } from "@/modules/approvals/application/ports";
import type { ApprovalCandidate } from "@/modules/approvals/domain/approval-context";

/** One person to seed, referring to others by key. */
export interface PersonSeed {
  role?: Role;
  canSelfApprove?: boolean;
  managerKey?: string;
  departmentKey?: string;
  isActive?: boolean;
  createdAt?: string;
  /** Seeded in the other company. */
  elsewhere?: boolean;
}

export interface Seeded {
  companyId: string;
  otherCompanyId: string;
  /** People's ids by key. */
  ids: Record<string, string>;
}

/** A fresh store for one case: seed people and departments (department key → manager key or null), then read. */
export interface ContextStore {
  seed(people: Record<string, PersonSeed>, departments?: Record<string, string | null>): Promise<Seeded>;
  reader: ApprovalContextReader;
}

/** A candidate as the rule reads it, without whatever else the store returns. */
const candidate = (c: ApprovalCandidate | null) => c && { id: c.id, isActive: c.isActive, createdAt: c.createdAt.toISOString() };

/**
 * What every {@link ApprovalContextReader} must do, run against the in-memory fake (in
 * `pnpm test`) and the Drizzle reader (in `pnpm test:integration`, on both drivers), so
 * the fake the use-case tests trust routes like the database.
 */
export function approvalContextReaderContract(name: string, make: () => Promise<ContextStore>): void {
  test(`${name}: requesters are the company's members by id, active or not`, async () => {
    const { seed, reader } = await make();
    const s = await seed({ ana: { managerKey: "mo", departmentKey: "ops", canSelfApprove: true }, mo: { role: "manager", isActive: false }, out: { elsewhere: true } }, { ops: null });
    const found = await reader.requesters(s.companyId, [s.ids.ana, s.ids.mo, s.ids.out, "00000000-0000-4000-8000-00000000dead"]);
    const byId = new Map(found.map((r) => [r.id, r]));
    assert.deepEqual([...byId.keys()].sort(), [s.ids.ana, s.ids.mo].sort());
    const ana = byId.get(s.ids.ana)!;
    assert.deepEqual({ role: ana.role, canSelfApprove: ana.canSelfApprove, managerId: ana.managerId }, { role: "employee", canSelfApprove: true, managerId: s.ids.mo });
    assert.ok(ana.departmentId, "the department is read");
    assert.equal(byId.get(s.ids.mo)!.role, "manager");
    assert.deepEqual(await reader.requesters(s.companyId, []), []);
  });

  test(`${name}: the context names the manager, the department's manager and the active admins, oldest first`, async () => {
    const { seed, reader } = await make();
    const s = await seed(
      {
        ana: { managerKey: "mo", departmentKey: "ops" },
        mo: { role: "manager", isActive: false, createdAt: "2025-03-01T00:00:00Z" },
        lead: { createdAt: "2025-02-01T00:00:00Z" },
        a2: { role: "admin", createdAt: "2025-02-01T00:00:00Z" },
        a1: { role: "admin", createdAt: "2025-01-01T00:00:00Z" },
        gone: { role: "admin", isActive: false, createdAt: "2024-01-01T00:00:00Z" },
      },
      { ops: "lead" },
    );
    const [ana] = await reader.requesters(s.companyId, [s.ids.ana]);
    const context = (await reader.contextsFor(s.companyId, [ana])).get(s.ids.ana)!;
    assert.equal(context.requester.id, s.ids.ana);
    assert.deepEqual(candidate(context.manager), { id: s.ids.mo, isActive: false, createdAt: "2025-03-01T00:00:00.000Z" }, "an inactive manager is read as such");
    assert.deepEqual(candidate(context.departmentManager), { id: s.ids.lead, isActive: true, createdAt: "2025-02-01T00:00:00.000Z" });
    assert.deepEqual(context.admins.map((a) => a.id), [s.ids.a1, s.ids.a2], "active admins only, longest-standing first");
  });

  test(`${name}: being one's own manager is ignored, and a manager elsewhere is no manager`, async () => {
    const { seed, reader } = await make();
    const s = await seed({ lead: { departmentKey: "ops", managerKey: "far" }, far: { role: "manager", elsewhere: true }, cy: {} }, { ops: "lead" });
    const requesters = await reader.requesters(s.companyId, [s.ids.lead, s.ids.cy]);
    const contexts = await reader.contextsFor(s.companyId, requesters);
    const lead = contexts.get(s.ids.lead)!;
    assert.equal(lead.manager, null, "a manager in another company does not count");
    assert.equal(lead.departmentManager, null, "the department's manager is the requester");
    const cy = contexts.get(s.ids.cy)!;
    assert.deepEqual([cy.manager, cy.departmentManager], [null, null], "no manager and no department");
    assert.deepEqual(cy.admins, []);
  });

  test(`${name}: a department without a manager adds nobody, and no requesters read nothing`, async () => {
    const { seed, reader } = await make();
    const s = await seed({ ana: { departmentKey: "ops" } }, { ops: null });
    const [ana] = await reader.requesters(s.companyId, [s.ids.ana]);
    assert.equal((await reader.contextsFor(s.companyId, [ana])).get(s.ids.ana)!.departmentManager, null);
    assert.equal((await reader.contextsFor(s.companyId, [])).size, 0);
  });
}
