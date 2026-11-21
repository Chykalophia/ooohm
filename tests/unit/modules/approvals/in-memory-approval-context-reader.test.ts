import { randomUUID } from "node:crypto";
import { approvalContextReaderContract, type PersonSeed } from "./contracts/approval-context-reader.contract";
import { InMemoryApprovalContextReader } from "./fakes/ports";
import { present } from "../../../support/present";

approvalContextReaderContract("in memory", async () => {
  const reader = new InMemoryApprovalContextReader();
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  return {
    reader,
    seed: async (people, departments = {}) => {
      const ids = new Map(Object.keys(people).map((k) => [k, randomUUID()]));
      const idOf = (key: string) => present(ids.get(key), `person ${key}`);
      const departmentIds = new Map(Object.keys(departments).map((k) => [k, randomUUID()]));
      const departmentOf = (key: string) => present(departmentIds.get(key), `department ${key}`);
      for (const [key, managerKey] of Object.entries(departments)) reader.departments.set(departmentOf(key), managerKey ? idOf(managerKey) : null);
      for (const [key, spec] of Object.entries<PersonSeed>(people)) {
        reader.people.set(idOf(key), {
          id: idOf(key),
          companyId: spec.elsewhere ? otherCompanyId : companyId,
          name: key,
          email: `${key}@example.test`,
          role: spec.role ?? "employee",
          canSelfApprove: spec.canSelfApprove ?? false,
          managerId: spec.managerKey ? idOf(spec.managerKey) : null,
          departmentId: spec.departmentKey ? departmentOf(spec.departmentKey) : null,
          isActive: spec.isActive ?? true,
          createdAt: new Date(spec.createdAt ?? "2025-06-01T00:00:00Z"),
        });
      }
      return { companyId, otherCompanyId, ids: Object.fromEntries(ids) as Record<keyof typeof people, string> };
    },
  };
});
