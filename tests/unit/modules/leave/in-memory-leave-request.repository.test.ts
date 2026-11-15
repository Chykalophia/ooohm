import { randomUUID } from "node:crypto";
import { leaveRequestRepositoryContract } from "./contracts/leave-request-repository.contract";
import { InMemoryLeaveRequestRepository } from "./fakes/in-memory-leave-request.repository";

leaveRequestRepositoryContract("in memory", async () => {
  const fixture = {
    companyId: randomUUID(),
    otherCompanyId: randomUUID(),
    userId: randomUUID(),
    otherUserId: randomUUID(),
    approverId: randomUUID(),
    leaveTypeId: randomUUID(),
    leaveTypeName: "PTO",
  };
  const repo = new InMemoryLeaveRequestRepository(
    { now: () => new Date() },
    { leaveTypes: { [fixture.leaveTypeId]: { name: fixture.leaveTypeName, color: "#0f766e" } }, people: {} },
  );
  return { fixture, use: (work) => work(repo) };
});
