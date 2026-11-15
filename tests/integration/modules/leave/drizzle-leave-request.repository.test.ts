import { after, before, describe } from "node:test";
import { drizzleLeaveRequestRepository } from "@/modules/leave/infrastructure/drizzle-leave-request.repository";
import { leaveRequestRepositoryContract } from "../../../unit/modules/leave/contracts/leave-request-repository.contract";
import { seedCompany } from "../../fixtures";
import { createTestDatabase, skip, type TestDatabase } from "../../harness";

describe("the Drizzle leave request repository", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  // Each case seeds its own company and runs in one transaction, as a unit of work does.
  leaveRequestRepositoryContract("drizzle", async () => {
    const co = await seedCompany(t.db, { ana: {}, bo: {}, mo: { role: "manager" } });
    const other = await seedCompany(t.db, {});
    return {
      fixture: {
        companyId: co.companyId,
        otherCompanyId: other.companyId,
        userId: co.people.ana.id,
        otherUserId: co.people.bo.id,
        approverId: co.people.mo.id,
        leaveTypeId: co.pto,
        leaveTypeName: "PTO",
      },
      use: (work) => t.db.transaction((tx) => work(drizzleLeaveRequestRepository(tx))),
    };
  });
});
