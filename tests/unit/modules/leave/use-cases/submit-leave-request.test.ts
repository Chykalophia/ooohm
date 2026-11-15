import assert from "node:assert/strict";
import { test } from "node:test";
import { SUBMIT_LIMIT, submitLeaveRequest } from "@/modules/leave/application/use-cases/submit-leave-request";
import { actorFor, ANA, COMPANY, type LeaveKit, leaveKit, MO, person, VACATION } from "../fakes/ports";

const draft = { leaveTypeId: VACATION, startDate: "2026-11-09", endDate: "2026-11-10", dayPortion: "full" as const, note: "  Family visit " };

function team(): LeaveKit {
  const kit = leaveKit();
  kit.directory.add(person(MO, "Mo", { role: "manager" }), person(ANA, "Ana", { managerId: MO }));
  return kit;
}
const ana = (kit: LeaveKit) => actorFor(kit.directory.people.get(ANA)!);

test("returns the stored request as a DTO, pending with the requester's manager", async () => {
  const kit = team();
  const r = await submitLeaveRequest(kit.deps, ana(kit), draft);
  assert.ok(r.ok);
  assert.deepEqual(
    { ...r.value, createdAt: undefined, updatedAt: undefined },
    {
      id: "00000000-0000-4000-8000-000000000001",
      companyId: COMPANY,
      userId: ANA,
      leaveTypeId: VACATION,
      startDate: "2026-11-09",
      endDate: "2026-11-10",
      dayPortion: "full",
      days: 2,
      note: "Family visit",
      status: "pending",
      approverId: MO,
      decidedAt: null,
      decisionNote: null,
      createdAt: undefined,
      updatedAt: undefined,
      headsUp: false,
    },
  );
  assert.deepEqual(kit.requests.yearDays.get(r.value.id), [{ year: 2026, days: 2 }]);
});

test("writes one audit row and one leave.requested event, in one unit of work, and asks the approver", async () => {
  const kit = team();
  await submitLeaveRequest(kit.deps, ana(kit), draft);
  assert.equal(kit.units.run, 1);
  assert.deepEqual(
    kit.audit.entries.map((e) => [e.action, e.before, e.source]),
    [["leave_request.requested", null, { kind: "user", userId: ANA }]],
  );
  assert.deepEqual(kit.outbox.types(), ["leave.requested"]);
  assert.deepEqual(kit.directory.locks, [`company:${COMPANY}`, `member:${ANA}`], "the company share lock first, then the member");
  assert.deepEqual(
    kit.sent.map((m) => [m.type, m.to]),
    [["leave.requested", "mo@example.test"]],
  );
  const mail = kit.sent[0] as Extract<(typeof kit.sent)[number], { type: "leave.requested" }>;
  assert.equal(mail.data.approveLink, "https://ooohm.test/approve/00000000-0000-4000-8000-000000000001." + MO);
  assert.equal(mail.data.alsoOff, "Nobody else is off then.");
});

test("a self-approved request is approved at once: two audit rows and two events", async () => {
  const kit = leaveKit();
  kit.directory.add(person(ANA, "Ana", { canSelfApprove: true }));
  const r = await submitLeaveRequest(kit.deps, ana(kit), draft);
  assert.ok(r.ok);
  assert.equal(r.value.status, "approved");
  assert.equal(r.value.approverId, ANA);
  assert.deepEqual(r.value.decidedAt, kit.clock.now());
  assert.deepEqual(
    kit.audit.entries.map((e) => e.action),
    ["leave_request.requested", "leave_request.approved"],
  );
  assert.deepEqual(kit.outbox.types(), ["leave.requested", "leave.approved"]);
  assert.deepEqual(
    kit.sent.map((m) => m.type),
    ["leave.approved"],
  );
});

test(`refuses the request after ${SUBMIT_LIMIT} in ten minutes with rate_limited, writing nothing`, async () => {
  const kit = team();
  const weekdays = ["01", "02", "03", "04", "07", "08", "09", "10", "11", "14", "15", "16"].map((d) => `2026-12-${d}`);
  for (const day of weekdays.slice(0, SUBMIT_LIMIT)) {
    assert.ok((await submitLeaveRequest(kit.deps, ana(kit), { ...draft, startDate: day, endDate: day, note: null })).ok, day);
  }
  const before = { rows: kit.requests.rows.size, events: kit.outbox.events.length };
  const r = await submitLeaveRequest(kit.deps, ana(kit), { ...draft, startDate: "2027-02-01", endDate: "2027-02-01" });
  assert.ok(!r.ok);
  assert.equal(r.error.code, "rate_limited");
  assert.deepEqual({ rows: kit.requests.rows.size, events: kit.outbox.events.length }, before);
  kit.clock.advance(11 * 60_000);
  assert.ok((await submitLeaveRequest(kit.deps, ana(kit), { ...draft, startDate: "2027-02-01", endDate: "2027-02-01" })).ok, "the window moves on");
});

test("insufficient_balance carries the year, the days requested and the days remaining", async () => {
  const kit = team();
  kit.allowances.remaining.set(2026, 1);
  const r = await submitLeaveRequest(kit.deps, ana(kit), draft);
  assert.ok(!r.ok);
  assert.equal(r.error.code, "insufficient_balance");
  assert.deepEqual(r.error.details, { year: 2026, requested: 2, remaining: 1, yearsSpanned: 1 });
  assert.equal(kit.units.rolledBack, 1);
  assert.equal(kit.requests.rows.size, 0);
  assert.equal(kit.outbox.events.length, 0);
});

test("with approval turned off it is booked with the heads-up flag, and whoever is told reads the coverage warning", async () => {
  const kit = team();
  kit.directory.settings = { ...kit.directory.settings, approvalMode: "heads_up" };
  kit.alsoOff.line = { others: 2, line: "Also off then: Cy and Di.", coverage: "This puts 3 people in Design off on Mon, Nov 9. The limit is 2." };
  const r = await submitLeaveRequest(kit.deps, ana(kit), draft);
  assert.ok(r.ok);
  assert.equal(r.value.headsUp, true);
  assert.equal(r.value.status, "approved");
  assert.equal(r.value.approverId, ANA, "nobody else decided it");
  assert.deepEqual(
    kit.sent.map((m) => [m.type, m.to]),
    [
      ["leave.booked", "ana@example.test"],
      ["leave.heads_up", "mo@example.test"],
    ],
  );
  const told = kit.sent[1] as Extract<(typeof kit.sent)[number], { type: "leave.heads_up" }>;
  assert.equal(told.data.alsoOff, "This puts 3 people in Design off on Mon, Nov 9. The limit is 2. Also off then: Cy and Di.");
  assert.deepEqual(kit.alsoOff.asked, [{ readerId: MO }]);
});

test("an overlapping request is refused, and malformed input never opens a unit of work", async () => {
  const kit = team();
  assert.ok((await submitLeaveRequest(kit.deps, ana(kit), draft)).ok);
  const overlap = await submitLeaveRequest(kit.deps, ana(kit), { ...draft, startDate: "2026-11-10", endDate: "2026-11-11" });
  assert.ok(!overlap.ok && overlap.error.code === "overlapping_request");
  const runs = kit.units.run;
  for (const [input, code] of [
    [{ ...draft, endDate: "2026-11-01" }, "invalid_date_range"],
    [{ ...draft, dayPortion: "am" as const }, "half_day_multi_day"],
    [{ ...draft, leaveTypeId: "vacation" }, "leave_type_unavailable"],
    [{ ...draft, note: "x".repeat(501) }, "invalid_input"],
  ] as const) {
    const r = await submitLeaveRequest(kit.deps, ana(kit), input);
    assert.ok(!r.ok && r.error.code === code, code);
  }
  assert.equal(kit.units.run, runs);
});

test("an inactive requester is forbidden; a weekend-only request is zero_days", async () => {
  const kit = team();
  kit.directory.people.set(ANA, { ...kit.directory.people.get(ANA)!, isActive: false });
  const r = await submitLeaveRequest(kit.deps, ana(kit), draft);
  assert.ok(!r.ok && r.error.code === "forbidden");
  const active = team();
  const weekend = await submitLeaveRequest(active.deps, ana(active), { ...draft, startDate: "2026-11-07", endDate: "2026-11-08" });
  assert.ok(!weekend.ok && weekend.error.code === "zero_days");
});
