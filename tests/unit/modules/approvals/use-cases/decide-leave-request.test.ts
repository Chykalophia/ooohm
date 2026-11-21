import assert from "node:assert/strict";
import { test } from "node:test";
import { approveLinkFor } from "@/modules/approvals/application/approve-link";
import { approveFromEmail } from "@/modules/approvals/application/use-cases/approve-from-email";
import { decideLeaveRequest } from "@/modules/approvals/application/use-cases/decide-leave-request";
import { readEmailApproval } from "@/modules/approvals/application/queries/read-email-approval";
import { unwrap } from "@/shared/lib/result";
import { type ApprovalKit, approvalKit } from "../fakes/ports";
import { first } from "../../../../support/present";

const ANA = "00000000-0000-4000-8000-0000000000b1";
const MO = "00000000-0000-4000-8000-0000000000b2";
const BOSS = "00000000-0000-4000-8000-0000000000b3";
const CY = "00000000-0000-4000-8000-0000000000b4";

/** Ana reports to Mo; Boss is the admin; Cy is a colleague. Ana has a request waiting on Mo. */
function team(): { kit: ApprovalKit; requestId: string } {
  const kit = approvalKit();
  kit.add(BOSS, "Boss", { role: "admin" });
  kit.add(MO, "Mo", { role: "manager", managerId: BOSS });
  kit.add(ANA, "Ana", { managerId: MO });
  kit.add(CY, "Cy", { managerId: MO });
  return { kit, requestId: kit.request(ANA, MO).id };
}

const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? "ok" : r.error!.code);
const tokenOf = (link: string | null) => link!.slice(link!.lastIndexOf("/") + 1);

test("the assigned approver approves: one decision recorded, the requester emailed", async () => {
  const { kit, requestId } = team();
  const r = unwrap(await decideLeaveRequest(kit.deps, kit.as(MO), { requestId, decision: "approve" }));
  assert.equal(r.status, "approved");
  assert.deepEqual(r.decidedAt, kit.clock.now());
  assert.deepEqual(kit.changes.kinds(), ["approved"]);
  assert.deepEqual(first(kit.changes.written).source, { kind: "user", userId: MO });
  assert.deepEqual(kit.sent.map((m) => [m.type, m.to]), [["leave.approved", "ana@example.test"]]);
});

test("rejecting needs no reason; a reason given is stored and sent", async () => {
  const { kit, requestId } = team();
  const r = unwrap(await decideLeaveRequest(kit.deps, kit.as(MO), { requestId, decision: "reject" }));
  assert.equal(r.status, "rejected");
  assert.equal(r.decisionNote, null);
  const other = kit.request(ANA, MO, { startDate: "2026-11-16", endDate: "2026-11-16" });
  const withReason = unwrap(await decideLeaveRequest(kit.deps, kit.as(MO), { requestId: other.id, decision: "reject", reason: "  Busy week  " }));
  assert.equal(withReason.decisionNote, "Busy week");
  assert.equal((kit.sent.at(-1)!.data as { reason: string }).reason, "Busy week");
});

test("an admin decides a request assigned to someone else", async () => {
  const { kit, requestId } = team();
  assert.equal(unwrap(await decideLeaveRequest(kit.deps, kit.as(BOSS), { requestId, decision: "approve" })).status, "approved");
});

test("anyone else is forbidden, and nothing is written", async () => {
  const { kit, requestId } = team();
  assert.equal(code(await decideLeaveRequest(kit.deps, kit.as(CY), { requestId, decision: "approve" })), "forbidden");
  assert.equal(code(await decideLeaveRequest(kit.deps, kit.as(ANA), { requestId, decision: "approve" })), "forbidden", "never one's own");
  assert.deepEqual(kit.changes.written, []);
  assert.equal(kit.requests.rows.get(requestId)?.status, "pending");
});

test("an approver the rule no longer picks (the manager changed) cannot decide on the old assignment", async () => {
  const { kit, requestId } = team();
  kit.contexts.people.set(ANA, { ...kit.contexts.people.get(ANA)!, managerId: CY });
  assert.equal(code(await decideLeaveRequest(kit.deps, kit.as(MO), { requestId, decision: "approve" })), "forbidden");
});

test("bad input fails before anything opens; a decided request is invalid_transition", async () => {
  const { kit, requestId } = team();
  assert.equal(code(await decideLeaveRequest(kit.deps, kit.as(MO), { requestId: "nope", decision: "approve" })), "not_found");
  assert.equal(code(await decideLeaveRequest(kit.deps, kit.as(MO), { requestId: "00000000-0000-4000-8000-00000000ffff", decision: "approve" })), "not_found");
  assert.equal(code(await decideLeaveRequest(kit.deps, kit.as(MO), { requestId, decision: "maybe" as "approve" })), "invalid_input");
  assert.equal(code(await decideLeaveRequest(kit.deps, kit.as(MO), { requestId, decision: "reject", reason: "x".repeat(2000) })), "invalid_input");
  assert.equal(kit.units.run, 1, "only the unknown id reached a transaction");
  unwrap(await decideLeaveRequest(kit.deps, kit.as(MO), { requestId, decision: "approve" }));
  assert.equal(code(await decideLeaveRequest(kit.deps, kit.as(BOSS), { requestId, decision: "reject" })), "invalid_transition");
});

test("assignedTo holds only while the request is still the actor's", async () => {
  const { kit, requestId } = team();
  assert.equal(code(await decideLeaveRequest(kit.deps, kit.as(BOSS), { requestId, decision: "approve", assignedTo: BOSS })), "forbidden", "even an admin");
  assert.equal(code(await decideLeaveRequest(kit.deps, kit.as(MO), { requestId, decision: "approve", assignedTo: BOSS })), "forbidden", "must be the actor");
  assert.equal(unwrap(await decideLeaveRequest(kit.deps, kit.as(MO), { requestId, decision: "approve", assignedTo: MO })).status, "approved");
});

test("approve from the email: a valid, unexpired link approves as the approver, through the link", async () => {
  const { kit, requestId } = team();
  const token = tokenOf(approveLinkFor(kit.deps, requestId, MO));
  assert.equal((await readEmailApproval(kit.deps, token)).state, "ready", "reading changes nothing");
  assert.equal(kit.changes.written.length, 0);
  const done = unwrap(await approveFromEmail(kit.deps, token));
  assert.equal(done.state, "approved");
  assert.deepEqual(first(kit.changes.written).source, { kind: "user", userId: MO, via: "email_link" });
  assert.equal(unwrap(await approveFromEmail(kit.deps, token)).state, "decided", "a second press changes nothing");
});

test("approve from the email refuses a forged, expired or keyless link", async () => {
  const { kit, requestId } = team();
  const token = tokenOf(approveLinkFor(kit.deps, requestId, MO));
  assert.equal(unwrap(await approveFromEmail(kit.deps, `${token.slice(0, -2)}xx`)).state, "invalid");
  assert.equal(unwrap(await approveFromEmail({ ...kit.deps, linkKey: undefined }, token)).state, "invalid");
  kit.clock.advance(8 * 86_400_000);
  assert.equal(unwrap(await approveFromEmail(kit.deps, token)).state, "expired");
  assert.equal(kit.requests.rows.get(requestId)?.status, "pending");
});

test("approve from the email needs the approver still assigned and active", async () => {
  const { kit, requestId } = team();
  const token = tokenOf(approveLinkFor(kit.deps, requestId, MO));
  const bossToken = tokenOf(approveLinkFor(kit.deps, requestId, BOSS));
  assert.equal(unwrap(await approveFromEmail(kit.deps, bossToken)).state, "not_yours", "an admin's link speaks only for an assignment");
  kit.requests.rows.set(requestId, { ...kit.requests.rows.get(requestId)!, approverId: BOSS });
  assert.equal(unwrap(await approveFromEmail(kit.deps, token)).state, "not_yours", "reassigned since the email");
  kit.requests.rows.set(requestId, { ...kit.requests.rows.get(requestId)!, approverId: MO });
  kit.contexts.people.set(MO, { ...kit.contexts.people.get(MO)!, isActive: false });
  assert.equal(unwrap(await approveFromEmail(kit.deps, token)).state, "not_yours", "deactivated");
  assert.equal(kit.requests.rows.get(requestId)?.status, "pending");
});
