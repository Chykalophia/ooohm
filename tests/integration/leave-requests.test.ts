import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { decideLeaveRequest } from "@/server/services/approvals";
import { cancelLeaveRequest, getDashboard, SUBMIT_LIMIT, submitLeaveRequest } from "@/server/services/leave-requests";
import { rejectsWith } from "./assertions";
import { auditFor, eventsFor, requestsOf, seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

// Dates: 2026-11-02 is a Monday; 2026-11-26 (Thu) is the seeded holiday.

describe("leave requests: submit and cancel", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  test("an employee's request waits for their manager, with days counted server-side", async () => {
    const co = await seedCompany(t.db, { manager: { role: "manager" }, ana: { managerKey: "manager" } });
    const ctx = createTestContext(t.db);
    const { ana, manager } = co.people;

    // Mon 23 to Fri 27 Nov: five weekdays, minus the Thanksgiving holiday.
    const req = await submitLeaveRequest(ctx, ana, {
      leaveTypeId: co.pto,
      startDate: "2026-11-23",
      endDate: "2026-11-27",
      dayPortion: "full",
      note: "  Family visit  ",
    });
    assert.equal(req.status, "pending");
    assert.equal(req.days, 4);
    assert.equal(req.approverId, manager.id);
    assert.equal(req.decidedAt, null);
    assert.equal(req.note, "Family visit");
    assert.equal(req.startDate, "2026-11-23");
    assert.equal(req.endDate, "2026-11-27");

    const audit = await auditFor(t.db, req.id);
    assert.deepEqual(audit.map((a) => [a.action, a.actorId]), [["leave_request.requested", ana.id]]);
    assert.equal(audit[0].before, null);
    assert.equal((audit[0].after as { status: string }).status, "pending");

    const events = await eventsFor(t.db, co.companyId, req.id);
    assert.deepEqual(events.map((e) => e.type), ["leave.requested"]);
    assert.deepEqual(events[0].payload, {
      requestId: req.id,
      userId: ana.id,
      leaveTypeId: co.pto,
      startDate: "2026-11-23",
      endDate: "2026-11-27",
      dayPortion: "full",
      days: 4,
      status: "pending",
      actorId: ana.id,
      actor: { type: "user", id: ana.id },
    });

    // Email goes out only after commit, and only to the approver.
    assert.equal(ctx.sent.length, 0);
    await ctx.settle();
    assert.deepEqual(ctx.sent.map((m) => [m.to, m.subject]), [[manager.email, "Time off request to review"]]);
    assert.match(ctx.sent[0].text, /Ana asked for time off/);
    assert.match(ctx.sent[0].text, /https:\/\/ooohm\.test\/approvals/);
  });

  test("self-approval approves at once and writes both transitions; without it the same request waits", async () => {
    const co = await seedCompany(t.db, {
      owner: { role: "admin", canSelfApprove: true },
      ana: { role: "employee", canSelfApprove: false, managerKey: "owner" },
    });
    const now = new Date("2026-11-01T12:34:56Z");
    const ctx = createTestContext(t.db, { now });
    const input = { leaveTypeId: co.pto, startDate: "2026-11-02", endDate: "", dayPortion: "full" as const };

    const own = await submitLeaveRequest(ctx, co.people.owner, input);
    assert.equal(own.status, "approved");
    assert.equal(own.approverId, co.people.owner.id);
    assert.equal(own.decidedAt?.toISOString(), now.toISOString());
    assert.equal(own.endDate, "2026-11-02");
    assert.deepEqual((await auditFor(t.db, own.id)).map((a) => a.action), ["leave_request.requested", "leave_request.approved"]);
    assert.deepEqual(
      (await eventsFor(t.db, co.companyId, own.id)).map((e) => [e.type, (e.payload as { status: string }).status]),
      [
        ["leave.requested", "pending"],
        ["leave.approved", "approved"],
      ],
    );

    const ana = await submitLeaveRequest(ctx, co.people.ana, input);
    assert.equal(ana.status, "pending");
    assert.equal(ana.approverId, co.people.owner.id);
    assert.deepEqual((await eventsFor(t.db, co.companyId, ana.id)).map((e) => e.type), ["leave.requested"]);

    await ctx.settle();
    // Self-approved: a confirmation to the requester and no "to review" email.
    // Routed: the approver is asked to review.
    assert.deepEqual(ctx.sent.map((m) => [m.to, m.subject]), [
      [co.people.owner.email, "Your time off is approved"],
      [co.people.owner.email, "Time off request to review"],
    ]);
  });

  test("an inactive manager falls back to the oldest active admin", async () => {
    const co = await seedCompany(t.db, {
      newAdmin: { role: "admin", createdAt: "2026-06-01T00:00:00Z" },
      oldAdmin: { role: "admin", createdAt: "2025-01-01T00:00:00Z" },
      gone: { role: "manager", isActive: false },
      ana: { managerKey: "gone" },
    });
    const req = await submitLeaveRequest(createTestContext(t.db), co.people.ana, {
      leaveTypeId: co.pto,
      startDate: "2026-11-03",
      dayPortion: "full",
    });
    assert.equal(req.approverId, co.people.oldAdmin.id);
  });

  test("a company's only admin is routed their own request; with nobody to approve, nothing is written", async () => {
    const solo = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const req = await submitLeaveRequest(ctx, solo.people.boss, { leaveTypeId: solo.pto, startDate: "2026-11-03", dayPortion: "full" });
    assert.equal(req.status, "pending");
    assert.equal(req.approverId, solo.people.boss.id);
    await ctx.settle();
    assert.equal(ctx.sent.length, 0, "nobody is emailed to review their own request");

    const orphan = await seedCompany(t.db, { ana: {}, gone: { role: "admin", isActive: false } });
    const ctx2 = createTestContext(t.db);
    await rejectsWith(
      submitLeaveRequest(ctx2, orphan.people.ana, { leaveTypeId: orphan.pto, startDate: "2026-11-03", dayPortion: "full" }),
      "no_approver",
    );
    assert.equal((await requestsOf(t.db, orphan.people.ana.id)).length, 0);
    assert.equal(ctx2.deferred(), 0);
  });

  test("rejects zero-day, backwards, multi-day half, archived, foreign and malformed requests without writing", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" } });
    const other = await seedCompany(t.db, { x: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const ana = co.people.ana;
    const base = { leaveTypeId: co.pto, dayPortion: "full" as const };

    await rejectsWith(submitLeaveRequest(ctx, ana, { ...base, startDate: "2026-11-07", endDate: "2026-11-08" }), "zero_days");
    await rejectsWith(submitLeaveRequest(ctx, ana, { ...base, startDate: "2026-11-26" }), "zero_days");
    await rejectsWith(submitLeaveRequest(ctx, ana, { ...base, startDate: "2026-11-06", endDate: "2026-11-02" }), "invalid_date_range");
    await rejectsWith(
      submitLeaveRequest(ctx, ana, { ...base, startDate: "2026-11-02", endDate: "2026-11-03", dayPortion: "am" }),
      "half_day_multi_day",
    );
    await rejectsWith(submitLeaveRequest(ctx, ana, { ...base, leaveTypeId: co.archived, startDate: "2026-11-02" }), "leave_type_unavailable");
    await rejectsWith(submitLeaveRequest(ctx, ana, { ...base, leaveTypeId: other.pto, startDate: "2026-11-02" }), "leave_type_unavailable");
    await rejectsWith(submitLeaveRequest(ctx, ana, { ...base, leaveTypeId: "not-a-uuid", startDate: "2026-11-02" }), "leave_type_unavailable");
    await rejectsWith(submitLeaveRequest(ctx, ana, { ...base, startDate: "2026-02-30" }), "invalid_input");
    await rejectsWith(submitLeaveRequest(ctx, ana, { ...base, startDate: "2026-11-02", note: "x".repeat(501) }), "invalid_input");

    assert.equal((await requestsOf(t.db, ana.id)).length, 0);
    assert.equal(ctx.deferred(), 0);
  });

  test("overlaps with pending or approved time are refused; am + pm on one date fit; closed requests free the dates", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" } });
    const ctx = createTestContext(t.db);
    const ana = co.people.ana;
    const ask = (startDate: string, endDate: string, dayPortion: "full" | "am" | "pm" = "full") =>
      submitLeaveRequest(ctx, ana, { leaveTypeId: co.pto, startDate, endDate, dayPortion });

    const week = await ask("2026-11-09", "2026-11-13");
    await rejectsWith(ask("2026-11-13", "2026-11-16"), "overlapping_request");
    await rejectsWith(ask("2026-11-11", "2026-11-11", "am"), "overlapping_request");

    const am = await ask("2026-11-17", "2026-11-17", "am");
    const pm = await ask("2026-11-17", "2026-11-17", "pm");
    assert.equal(am.days + pm.days, 1);
    await rejectsWith(ask("2026-11-17", "2026-11-17", "pm"), "overlapping_request");
    await rejectsWith(ask("2026-11-17", "2026-11-17"), "overlapping_request");

    await cancelLeaveRequest(ctx, ana, week.id);
    const again = await ask("2026-11-13", "2026-11-16");
    assert.equal(again.days, 2);
  });

  test("two overlapping requests sent at the same moment: exactly one is stored", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" } });
    const ctx = createTestContext(t.db);
    const input = { leaveTypeId: co.pto, startDate: "2026-12-01", endDate: "2026-12-03", dayPortion: "full" as const };

    const results = await Promise.allSettled([
      submitLeaveRequest(ctx, co.people.ana, input),
      submitLeaveRequest(ctx, co.people.ana, input),
      submitLeaveRequest(ctx, co.people.ana, input),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await requestsOf(t.db, co.people.ana.id)).length, 1);
  });

  test("two admins who approve each other can submit at the same moment without deadlocking", async () => {
    // Each request's approver_id references the other admin, so each insert's FK check
    // needs a KEY SHARE lock on the row the other transaction locked for itself.
    for (let round = 0; round < 5; round++) {
      const co = await seedCompany(t.db, {
        a: { role: "admin", createdAt: "2025-01-01T00:00:00Z" },
        b: { role: "admin", createdAt: "2025-02-01T00:00:00Z" },
      });
      const ctx = createTestContext(t.db);
      const input = { leaveTypeId: co.pto, startDate: "2026-12-01", dayPortion: "full" as const };
      const [a, b] = await Promise.all([
        submitLeaveRequest(ctx, co.people.a, input),
        submitLeaveRequest(ctx, co.people.b, input),
      ]);
      assert.deepEqual([a.approverId, b.approverId], [co.people.b.id, co.people.a.id]);
      assert.deepEqual((await eventsFor(t.db, co.companyId, a.id)).map((e) => e.type), ["leave.requested"]);
      assert.deepEqual((await eventsFor(t.db, co.companyId, b.id)).map((e) => e.type), ["leave.requested"]);
    }
  });

  test("cancelling a pending request tells the requester and the approver", async () => {
    const co = await seedCompany(t.db, { manager: { role: "manager" }, ana: { managerKey: "manager" } });
    const ctx = createTestContext(t.db);
    const req = await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-04", dayPortion: "pm" });
    await ctx.settle();
    ctx.sent.length = 0;

    const cancelled = await cancelLeaveRequest(ctx, co.people.ana, req.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.decidedAt, null);
    assert.deepEqual((await auditFor(t.db, req.id)).map((a) => a.action), ["leave_request.requested", "leave_request.cancelled"]);
    const events = await eventsFor(t.db, co.companyId, req.id);
    assert.deepEqual(events.map((e) => e.type), ["leave.requested", "leave.cancelled"]);
    assert.equal((events[1].payload as { actorId: string }).actorId, co.people.ana.id);

    await ctx.settle();
    assert.deepEqual(ctx.sent.map((m) => [m.to, m.subject]).sort(), [
      [co.people.ana.email, "Your time off request was cancelled"],
      [co.people.manager.email, "A time off request was cancelled"],
    ].sort());
  });

  test("a requester with a blank name is named by email in the approver's mail, on submit and on cancel", async () => {
    const co = await seedCompany(t.db, { manager: { role: "manager" }, ana: { managerKey: "manager" } });
    await t.db.update(schema.user).set({ name: "  " }).where(eq(schema.user.id, co.people.ana.id));
    const ctx = createTestContext(t.db);
    const { ana, manager } = co.people;

    const req = await submitLeaveRequest(ctx, ana, { leaveTypeId: co.pto, startDate: "2026-11-05", dayPortion: "full" });
    await cancelLeaveRequest(ctx, ana, req.id);
    await ctx.settle();

    const intros = ctx.sent
      .filter((m) => m.to === manager.email)
      .map((m) => m.text.split("\n")[2])
      .sort();
    assert.deepEqual(intros, [
      `${ana.email} asked for time off.`,
      `${ana.email} cancelled their time off. Nothing else is needed from you.`,
    ]);
  });

  test("a self-approved request can be cancelled after approval, and only the requester is emailed", async () => {
    const co = await seedCompany(t.db, { owner: { role: "admin", canSelfApprove: true } });
    const ctx = createTestContext(t.db);
    const req = await submitLeaveRequest(ctx, co.people.owner, { leaveTypeId: co.pto, startDate: "2026-11-05", dayPortion: "full" });
    assert.equal(req.status, "approved");
    await ctx.settle();
    ctx.sent.length = 0;

    const cancelled = await cancelLeaveRequest(ctx, co.people.owner, req.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.decidedAt?.toISOString(), req.decidedAt?.toISOString(), "approval time is kept");
    await ctx.settle();
    assert.deepEqual(ctx.sent.map((m) => m.to), [co.people.owner.email]);
  });

  test("only the requester can cancel, and a closed request cannot be cancelled again", async () => {
    const co = await seedCompany(t.db, { manager: { role: "manager" }, boss: { role: "admin" }, ana: { managerKey: "manager" } });
    const outsider = await seedCompany(t.db, { x: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const req = await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-06", dayPortion: "full" });

    await rejectsWith(cancelLeaveRequest(ctx, co.people.manager, req.id), "forbidden");
    await rejectsWith(cancelLeaveRequest(ctx, co.people.boss, req.id), "forbidden");
    await rejectsWith(cancelLeaveRequest(ctx, outsider.people.x, req.id), "not_found");
    await rejectsWith(cancelLeaveRequest(ctx, co.people.ana, "nope"), "not_found");

    await cancelLeaveRequest(ctx, co.people.ana, req.id);
    await rejectsWith(cancelLeaveRequest(ctx, co.people.ana, req.id), "invalid_transition");
    assert.deepEqual((await auditFor(t.db, req.id)).map((a) => a.action), ["leave_request.requested", "leave_request.cancelled"]);
  });

  test("approved leave from a past year cannot be cancelled by the requester; nothing is written and it shows no Cancel", async () => {
    const co = await seedCompany(t.db, { manager: { role: "manager" }, ana: { managerKey: "manager" } });
    const in2025 = createTestContext(t.db, { now: new Date("2025-06-02T15:00:00Z") });
    const now = createTestContext(t.db); // 2026-11-01
    const { ana, manager } = co.people;
    // Mon Jun 16 2025: approved. Tue Jun 17: still pending (never decided).
    const taken = await submitLeaveRequest(in2025, ana, { leaveTypeId: co.pto, startDate: "2025-06-16", dayPortion: "full" });
    await decideLeaveRequest(in2025, manager, { requestId: taken.id, decision: "approve" });
    const undecided = await submitLeaveRequest(in2025, ana, { leaveTypeId: co.pto, startDate: "2025-06-17", dayPortion: "full" });
    const thisYear = await submitLeaveRequest(now, ana, { leaveTypeId: co.pto, startDate: "2026-11-09", dayPortion: "full" });
    await decideLeaveRequest(now, manager, { requestId: thisYear.id, decision: "approve" });
    await in2025.settle();
    await now.settle();
    const mailBefore = now.sent.length;

    const cancellable = new Map((await getDashboard(now, ana)).requests.map((r) => [r.id, r.cancellable]));
    assert.deepEqual([cancellable.get(taken.id), cancellable.get(undecided.id), cancellable.get(thisYear.id)], [false, true, true]);

    await rejectsWith(cancelLeaveRequest(now, ana, taken.id), "past_year_closed");
    const [row] = await requestsOf(t.db, ana.id).then((rs) => rs.filter((r) => r.id === taken.id));
    assert.equal(row.status, "approved");
    assert.deepEqual((await auditFor(t.db, taken.id)).map((a) => a.action), ["leave_request.requested", "leave_request.approved"]);
    await now.settle();
    assert.equal(now.sent.length, mailBefore, "no email");

    // The rule covers approved leave only: the undecided one is withdrawn, this year's cancelled.
    assert.equal((await cancelLeaveRequest(now, ana, undecided.id)).status, "cancelled");
    assert.equal((await cancelLeaveRequest(now, ana, thisYear.id)).status, "cancelled");
  });

  test("approved leave from a past year cannot be cancelled by an admin either, their own or anyone's", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin", canSelfApprove: true }, ana: { managerKey: "boss" } });
    const in2025 = createTestContext(t.db, { now: new Date("2025-03-03T15:00:00Z") });
    const now = createTestContext(t.db);
    const { boss, ana } = co.people;
    const own = await submitLeaveRequest(in2025, boss, { leaveTypeId: co.pto, startDate: "2025-03-10", dayPortion: "full" });
    assert.equal(own.status, "approved", "self-approved");
    const theirs = await submitLeaveRequest(in2025, ana, { leaveTypeId: co.pto, startDate: "2025-03-11", dayPortion: "full" });
    await decideLeaveRequest(in2025, boss, { requestId: theirs.id, decision: "approve" });

    assert.equal((await getDashboard(now, boss)).requests.find((r) => r.id === own.id)?.cancellable, false);
    await rejectsWith(cancelLeaveRequest(now, boss, own.id), "past_year_closed");
    await rejectsWith(cancelLeaveRequest(now, boss, theirs.id), "forbidden");
    await rejectsWith(cancelLeaveRequest(now, ana, theirs.id), "past_year_closed");
  });

  test("the year closes at midnight in the company's time zone, not the server's", async () => {
    const co = await seedCompany(t.db, { owner: { role: "admin", canSelfApprove: true } });
    const { owner } = co.people;
    const dec = createTestContext(t.db, { now: new Date("2025-12-01T15:00:00Z") });
    const req = await submitLeaveRequest(dec, owner, { leaveTypeId: co.pto, startDate: "2025-12-31", dayPortion: "full" });
    // 03:00 UTC on Jan 1 2026 is still Dec 31 in Chicago (the company's zone): last year is still open.
    const newYearsEveInChicago = createTestContext(t.db, { now: new Date("2026-01-01T03:00:00Z") });
    assert.equal((await getDashboard(newYearsEveInChicago, owner)).requests.find((r) => r.id === req.id)?.cancellable, true);
    await t.db.update(schema.companies).set({ timezone: "UTC" }).where(eq(schema.companies.id, co.companyId));
    await rejectsWith(cancelLeaveRequest(newYearsEveInChicago, owner, req.id), "past_year_closed");
  });

  test("a mail outage never fails the request; the change is committed and the failure logged", async () => {
    const co = await seedCompany(t.db, { manager: { role: "manager" }, ana: { managerKey: "manager" } });
    const ctx = createTestContext(t.db, {
      mailer: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const stderr = process.stderr.write.bind(process.stderr);
    const logged: string[] = [];
    process.stderr.write = ((chunk: string) => (logged.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      const req = await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-10", dayPortion: "full" });
      await ctx.settle();
      assert.equal(req.status, "pending");
      assert.equal((await requestsOf(t.db, co.people.ana.id)).length, 1);
    } finally {
      process.stderr.write = stderr;
    }
    assert.ok(logged.some((l) => l.includes('"event":"leave_email_failed"')));
  });

  test("the dashboard lists the actor's own requests and active leave types", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" }, bo: { managerKey: "boss" } });
    const ctx = createTestContext(t.db);
    await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-11", dayPortion: "full" });
    await submitLeaveRequest(ctx, co.people.bo, { leaveTypeId: co.pto, startDate: "2026-11-12", dayPortion: "full" });

    const dash = await getDashboard(ctx, co.people.ana);
    assert.deepEqual(dash.leaveTypes.map((lt) => lt.id), [co.pto]);
    assert.deepEqual(dash.requests.map((r) => [r.startDate, r.approverName]), [["2026-11-11", "Boss"]]);
  });

  test("the form defaults to the next working day in the company's time zone, so the default is always requestable", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" } });
    const defaultAt = async (now: string) => (await getDashboard(createTestContext(t.db, { now: new Date(now) }), co.people.ana)).defaultDate;

    assert.equal(await defaultAt("2026-11-03T03:00:00Z"), "2026-11-02", "Mon evening in Chicago, already Tue in UTC");
    assert.equal(await defaultAt("2026-11-07T15:00:00Z"), "2026-11-09", "Saturday: the following Monday");
    assert.equal(await defaultAt("2026-11-26T15:00:00Z"), "2026-11-27", "the Thanksgiving holiday: the day after");

    const ctx = createTestContext(t.db);
    const req = await submitLeaveRequest(ctx, co.people.ana, {
      leaveTypeId: co.pto,
      startDate: await defaultAt("2026-11-07T15:00:00Z"),
      dayPortion: "full",
    });
    assert.equal(req.days, 1);
  });

  test("submits are capped per person per window; cancelled ones still count, other people are unaffected", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" }, bo: { managerKey: "boss" } });
    const ctx = createTestContext(t.db);
    const ask = (who: "ana" | "bo", day: number) =>
      submitLeaveRequest(ctx, co.people[who], { leaveTypeId: co.pto, startDate: `2027-01-${String(day).padStart(2, "0")}`, dayPortion: "full" });

    // Weekdays from Mon 4 Jan 2027: 4-8, 11-15.
    const weekdays = [4, 5, 6, 7, 8, 11, 12, 13, 14, 15];
    assert.equal(weekdays.length, SUBMIT_LIMIT);
    const first = await ask("ana", weekdays[0]);
    await cancelLeaveRequest(ctx, co.people.ana, first.id);
    for (const day of weekdays.slice(1)) await ask("ana", day);

    await rejectsWith(ask("ana", 18), "rate_limited");
    assert.equal((await requestsOf(t.db, co.people.ana.id)).length, SUBMIT_LIMIT);
    assert.equal((await ask("bo", 18)).status, "pending");
  });
});
