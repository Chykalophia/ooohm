import { randomUUID } from "node:crypto";
import { approvalContextReaderContract } from "./contracts/approval-context-reader.contract";
import { InMemoryApprovalContextReader } from "./fakes/ports";

approvalContextReaderContract("in memory", async () => {
  const reader = new InMemoryApprovalContextReader();
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  return {
    reader,
    seed: async (people, departments = {}) => {
      const ids = Object.fromEntries(Object.keys(people).map((k) => [k, randomUUID()]));
      const departmentIds = Object.fromEntries(Object.keys(departments).map((k) => [k, randomUUID()]));
      for (const [key, managerKey] of Object.entries(departments)) reader.departments.set(departmentIds[key], managerKey ? ids[managerKey] : null);
      for (const [key, spec] of Object.entries(people)) {
        reader.people.set(ids[key], {
          id: ids[key],
          companyId: spec.elsewhere ? otherCompanyId : companyId,
          name: key,
          email: `${key}@example.test`,
          role: spec.role ?? "employee",
          canSelfApprove: spec.canSelfApprove ?? false,
          managerId: spec.managerKey ? ids[spec.managerKey] : null,
          departmentId: spec.departmentKey ? departmentIds[spec.departmentKey] : null,
          isActive: spec.isActive ?? true,
          createdAt: new Date(spec.createdAt ?? "2025-06-01T00:00:00Z"),
        });
      }
      return { companyId, otherCompanyId, ids };
    },
  };
});
