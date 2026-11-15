import assert from "node:assert/strict";
import { test } from "node:test";
import { reroutePending } from "@/modules/approvals/application/reroute-pending";
import { type ApprovalKit, approvalKit } from "../fakes/ports";

const ANA = "00000000-0000-4000-8000-0000000000b1";
const MO = "00000000-0000-4000-8000-0000000000b2";
const A1 = "00000000-0000-4000-8000-0000000000b3";
const A2 = "00000000-0000-4000-8000-0000000000b4";
const LEE = "00000000-0000-4000-8000-0000000000b5";

/** Ana reports to Mo; A1 is the longest-standing admin, A2 the next. */
function team(): ApprovalKit {
  const kit = approvalKit();
  kit.add(A1, "A1", { role: "admin", createdAt: new Date("2024-01-01T00:00:00Z") });
  kit.add(A2, "A2", { role: "admin", createdAt: new Date("2024-06-01T00:00:00Z") });
  kit.add(MO, "Mo", { role: "manager" });
  kit.add(ANA, "Ana", { managerId: MO });
  return kit;
}
const set = (kit: ApprovalKit, id: string, over: object) => kit.contexts.people.set(id, { ...kit.contexts.people.get(id)!, ...over });
const reroute = (kit: ApprovalKit, ...requests: Parameters<ApprovalKit["request"]>[]) =>
  reroutePending(kit.deps, kit.deps.read, kit.as(A1), requests.map((r) => kit.request(...r)));

test("a deactivated approver's request moves to the oldest admin, with a review email and its Approve link", async () => {
  const kit = team();
  set(kit, MO, { isActive: false });
  const { reassigned, notify } = await reroute(kit, [ANA, MO]);
  assert.equal(reassigned, 1);
  const [moved] = kit.changes.written;
  assert.deepEqual([moved.kind, moved.before?.approverId, moved.after.approverId], ["reassigned", MO, A1]);
  assert.deepEqual(notify.map((n) => [n.type, n.to]), [["leave.requested", "a1@example.test"]]);
  assert.match((notify[0].data as { approveLink: string }).approveLink, /^https:\/\/ooohm\.test\/approve\//);
});

test("a demoted admin's request moves to the next admin", async () => {
  const kit = team();
  set(kit, ANA, { managerId: null });
  set(kit, A1, { role: "employee" });
  const { reassigned } = await reroute(kit, [ANA, A1]);
  assert.equal(reassigned, 1);
  assert.equal(kit.changes.written[0].after.approverId, A2);
});

test("when the manager changes, the request follows the new manager", async () => {
  const kit = team();
  kit.add(LEE, "Lee", { role: "manager" });
  set(kit, ANA, { managerId: LEE });
  await reroute(kit, [ANA, MO]);
  assert.equal(kit.changes.written[0].after.approverId, LEE);
});

test("a new admin takes the request an only admin had routed to themself", async () => {
  const kit = approvalKit();
  kit.add(A1, "A1", { role: "admin", createdAt: new Date("2024-01-01T00:00:00Z") });
  const before = await reroute(kit, [A1, A1]);
  assert.equal(before.reassigned, 0, "alone, the admin keeps their own request");
  kit.add(A2, "A2", { role: "admin", createdAt: new Date("2024-06-01T00:00:00Z") });
  const [request] = [...kit.requests.rows.values()];
  const after = await reroutePending(kit.deps, kit.deps.read, kit.as(A1), [request]);
  assert.equal(after.reassigned, 1);
  assert.equal(kit.requests.rows.get(request.id)?.approverId, A2);
});

test("nothing moves when the rule still picks the same approver, and each request moves once", async () => {
  const kit = team();
  const r = kit.request(ANA, MO);
  const { reassigned, notify } = await reroutePending(kit.deps, kit.deps.read, kit.as(A1), [r, r]);
  assert.deepEqual([reassigned, notify.length, kit.changes.written.length], [0, 0, 0]);
});

test("a request nobody can take keeps no approver and sends no email; one moved meanwhile is left alone", async () => {
  const kit = approvalKit();
  kit.add(A1, "A1", { role: "admin", isActive: false });
  kit.add(MO, "Mo", { role: "manager", isActive: false });
  kit.add(ANA, "Ana", { managerId: MO });
  const orphaned = await reroute(kit, [ANA, MO]);
  assert.deepEqual([orphaned.reassigned, orphaned.notify.length], [1, 0]);
  assert.equal(kit.changes.written[0].after.approverId, null);

  const kit2 = team();
  set(kit2, MO, { isActive: false });
  const stale = kit2.request(ANA, MO);
  kit2.requests.rows.set(stale.id, { ...stale, approverId: A2 });
  const raced = await reroutePending(kit2.deps, kit2.deps.read, kit2.as(A1), [stale]);
  assert.equal(raced.reassigned, 0, "the compare-and-set lost to the concurrent move");
});
