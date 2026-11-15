import { randomUUID } from "node:crypto";
import { allowanceRepositoryContract } from "./contracts/allowance-repository.contract";
import { InMemoryAllowanceRepository } from "./fakes/in-memory-allowance.repository";

allowanceRepositoryContract("in memory", async () => {
  const repo = new InMemoryAllowanceRepository();
  return {
    fixture: { userId: randomUUID(), otherUserId: randomUUID(), leaveTypeId: randomUUID(), otherLeaveTypeId: randomUUID() },
    use: (work) =>
      work(repo, async (entry) => {
        repo.booked.push(entry);
      }),
  };
});
