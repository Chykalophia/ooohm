import { randomUUID } from "node:crypto";
import { after, before, describe } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { drizzleApprovalContextReader } from "@/modules/approvals/infrastructure/drizzle-approval-context.reader";
import { approvalContextReaderContract } from "../../../unit/modules/approvals/contracts/approval-context-reader.contract";
import { createTestDatabase, skip, type TestDatabase } from "../../harness";

describe("the Drizzle approval context reader", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  approvalContextReaderContract("drizzle", async () => ({
    reader: drizzleApprovalContextReader(t.db),
    seed: async (people, departments = {}) => {
      const company = async () => (await t.db.insert(schema.companies).values({ name: `Co ${randomUUID().slice(0, 8)}` }).returning())[0].id;
      const companyId = await company();
      const otherCompanyId = await company();
      const ids = Object.fromEntries(Object.keys(people).map((k) => [k, randomUUID()]));
      const departmentIds: Record<string, string> = {};
      for (const key of Object.keys(departments)) {
        const [d] = await t.db.insert(schema.departments).values({ companyId, name: `${key} ${randomUUID().slice(0, 8)}` }).returning();
        departmentIds[key] = d.id;
      }
      for (const [key, spec] of Object.entries(people)) {
        await t.db.insert(schema.user).values({
          id: ids[key],
          name: key,
          email: `${key}-${ids[key].slice(0, 8)}@example.com`,
          companyId: spec.elsewhere ? otherCompanyId : companyId,
          role: spec.role ?? "employee",
          canSelfApprove: spec.canSelfApprove ?? false,
          isActive: spec.isActive ?? true,
          departmentId: spec.departmentKey ? departmentIds[spec.departmentKey] : null,
          createdAt: new Date(spec.createdAt ?? "2025-06-01T00:00:00Z"),
        });
      }
      // Links once everyone exists, so specs can refer to each other.
      for (const [key, spec] of Object.entries(people)) {
        if (spec.managerKey) await t.db.update(schema.user).set({ managerId: ids[spec.managerKey] }).where(eqId(ids[key]));
      }
      for (const [key, managerKey] of Object.entries(departments)) {
        if (managerKey) await t.db.update(schema.departments).set({ managerId: ids[managerKey] }).where(eqDepartment(departmentIds[key]));
      }
      return { companyId, otherCompanyId, ids };
    },
  }));
});

const eqId = (id: string) => eq(schema.user.id, id);
const eqDepartment = (id: string) => eq(schema.departments.id, id);
