import { randomUUID } from "node:crypto";
import { allowanceRepositoryContract } from "./contracts/allowance-repository.contract";
import { InMemoryAllowanceRepository } from "./fakes/in-memory-allowance.repository";

allowanceRepositoryContract("in memory", async () => {
  const fixture = {
    companyId: randomUUID(),
    otherCompanyId: randomUUID(),
    userId: randomUUID(),
    otherUserId: randomUUID(),
    foreignUserId: randomUUID(),
    leaveTypeId: randomUUID(),
    otherLeaveTypeId: randomUUID(),
  };
  const companies = new Map<string, string>([
    [fixture.userId, fixture.companyId],
    [fixture.otherUserId, fixture.companyId],
    [fixture.foreignUserId, fixture.otherCompanyId],
  ]);
  const repo = new InMemoryAllowanceRepository((userId) => companies.get(userId));
  return {
    fixture,
    use: (work) =>
      work(repo, async (entry) => {
        repo.booked.push(entry);
      }),
  };
});
