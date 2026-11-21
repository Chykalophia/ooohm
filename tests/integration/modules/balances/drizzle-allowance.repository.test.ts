import { after, before, describe } from "node:test";
import * as schema from "@/db/schema";
import { drizzleAllowanceRepository } from "@/modules/balances/infrastructure/drizzle-allowance.repository";
import { allowanceRepositoryContract } from "../../../unit/modules/balances/contracts/allowance-repository.contract";
import { addLeaveType, seedCompany } from "../../fixtures";
import { createTestDatabase, skip, type TestDatabase } from "../../harness";
import { first } from "../../../support/present";

describe("the Drizzle allowance repository", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  // Each case seeds its own company and runs in one transaction, as a unit of work does.
  allowanceRepositoryContract("drizzle", async () => {
    const co = await seedCompany(t.db, { ana: {}, bo: {} });
    const other = await seedCompany(t.db, { cy: {} });
    const sick = await addLeaveType(t.db, co.companyId, { code: "SICK" });
    const companyOf = new Map([
      [co.people.ana.id, co.companyId],
      [co.people.bo.id, co.companyId],
      [other.people.cy.id, other.companyId],
    ]);
    let day = 0;
    return {
      fixture: {
        companyId: co.companyId,
        otherCompanyId: other.companyId,
        userId: co.people.ana.id,
        otherUserId: co.people.bo.id,
        foreignUserId: other.people.cy.id,
        leaveTypeId: co.pto,
        otherLeaveTypeId: sick,
      },
      use: (work) =>
        t.db.transaction((tx) =>
          // The request row holds a whole day; its per-year split carries the amount the sums read.
          work(drizzleAllowanceRepository(tx), async ({ userId, leaveTypeId, year, days, status }) => {
            const date = `${year}-03-${String(++day).padStart(2, "0")}`;
            const request = first(await tx
              .insert(schema.leaveRequests)
              .values({ companyId: companyOf.get(userId) ?? co.companyId, userId, leaveTypeId, startDate: date, endDate: date, days: 1, status })
              .returning({ id: schema.leaveRequests.id }));
            await tx.insert(schema.leaveRequestDays).values({ requestId: request.id, year, days });
          }),
        ),
    };
  });
});
