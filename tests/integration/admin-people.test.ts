import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { and, eq, isNull } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { INVITE_SUBJECT } from "@/server/notifications/templates/invite";
import {
  deactivatePerson,
  getPersonDetail,
  getPersonFormOptions,
  INVITE_LIMIT,
  invitePerson,
  listPeople,
  reactivatePerson,
  resendInvite,
  updatePerson,
} from "@/server/services/admin-people";
import { createApiKey, revokeApiKey } from "@/server/services/api-keys";
import { decideLeaveRequest } from "@/server/services/approvals";
import { issueCalendarFeed } from "@/server/services/calendar-feeds";
import { submitLeaveRequest } from "@/server/services/leave-requests";
import { createWebhookEndpoint, deleteWebhookEndpoint } from "@/server/services/webhooks";
import { rejectsWith } from "./assertions";
import { captureStderr, companyAudit, companyEvents, decidable, type PersonSpec, seedCompany, setAllowance, subjectOf } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

async function userRow(db: Database, id: string) {
  const [row] = await db.select().from(schema.user).where(eq(schema.user.id, id));
  return row;
}

async function addSession(db: Database, userId: string) {
  await db.insert(schema.session).values({
    id: randomUUID(),
    token: randomUUID(),
    userId,
    expiresAt: new Date("2027-01-01T00:00:00Z"),
  });
}

const invite = (over: Partial<Parameters<typeof invitePerson>[2]> = {}) => ({
  email: `New.Person-${randomUUID().slice(0, 6)}@Example.com`,
  name: "  New   Person ",
  departmentId: null,
  managerId: null,
  role: "employee",
  canSelfApprove: false,
  ...over,
});

const editOf = (p: { name: string }, over: Partial<Parameters<typeof updatePerson>[3]> = {}) => ({
  name: p.name,
  departmentId: null,
  managerId: null,
  role: "employee",
  canSelfApprove: false,
  ...over,
});

describe("admin: people", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  test("invite creates the person in the admin's company, audits it, and emails a sign-in link only after commit", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, mgr: { role: "manager" } });
    const [dept] = await t.db.insert(schema.departments).values({ companyId: co.companyId, name: "Ops" }).returning();
    const ctx = createTestContext(t.db);

    const input = invite({ departmentId: dept.id, managerId: co.people.mgr.id, role: "manager", canSelfApprove: true });
    const person = await invitePerson(ctx, co.people.boss, input);

    const row = await userRow(t.db, person.id);
    assert.deepEqual(
      [row.email, row.name, row.companyId, row.departmentId, row.managerId, row.role, row.canSelfApprove, row.isActive, row.emailVerified],
      [input.email.toLowerCase(), "New Person", co.companyId, dept.id, co.people.mgr.id, "manager", true, true, false],
    );

    // Nothing is sent, and no link exists, until the transaction has committed and settled.
    assert.equal(ctx.sent.length, 0);
    assert.deepEqual(ctx.signInLinks, []);
    await ctx.settle();
    assert.deepEqual(ctx.signInLinks, [row.email]);
    assert.equal(ctx.sent.length, 1);
    const [mail] = ctx.sent;
    assert.equal(mail.to, row.email);
    assert.equal(mail.subject, INVITE_SUBJECT);
    assert.match(mail.text, /Boss added you to Co [0-9a-f]{8} on OOOhm/);
    assert.ok(mail.text.includes("https://ooohm.test/api/auth/magic-link/verify?token=test-1"), "carries the issued link");
    assert.ok(mail.text.includes("https://ooohm.test/sign-in"));

    const audit = await companyAudit(t.db, co.companyId, "user.");
    assert.deepEqual(
      audit.map((a) => [a.action, a.actorId, a.entityType, a.entityId, a.subjectUserId, a.before]),
      [["user.created", co.people.boss.id, "user", person.id, person.id, null]],
    );
    assert.deepEqual(audit[0].after, {
      name: "New Person",
      email: row.email,
      role: "manager",
      departmentId: dept.id,
      levelId: null,
      managerId: co.people.mgr.id,
      canSelfApprove: true,
      isActive: true,
    });
    const events = await companyEvents(t.db, co.companyId, "user.");
    assert.deepEqual(
      events.map((e) => [e.type, e.payload]),
      [
        [
          "user.created",
          {
            userId: person.id,
            email: row.email,
            name: "New Person",
            role: "manager",
            departmentId: dept.id,
            levelId: null,
            managerId: co.people.mgr.id,
            canSelfApprove: true,
            isActive: true,
            actorId: co.people.boss.id,
            actor: { type: "user", id: co.people.boss.id },
          },
        ],
      ],
    );
    assert.ok(!JSON.stringify(events).includes("token"), "no link or token in the outbox");
  });

  test("only admins invite; a refused invite writes, sends and links nothing", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, mgr: { role: "manager" }, emp: {} });
    const ctx = createTestContext(t.db);
    for (const who of [co.people.mgr, co.people.emp]) {
      await rejectsWith(invitePerson(ctx, who, invite()), "forbidden");
    }
    // A session that still says admin but whose row was demoted is refused too.
    await t.db.update(schema.user).set({ role: "employee" }).where(eq(schema.user.id, co.people.boss.id));
    await rejectsWith(invitePerson(ctx, co.people.boss, invite()), "forbidden");
    await ctx.settle();
    assert.equal(ctx.sent.length, 0);
    assert.equal((await t.db.select().from(schema.user).where(eq(schema.user.companyId, co.companyId))).length, 3);
    assert.deepEqual(await companyAudit(t.db, co.companyId), []);
  });

  test("an email already in use, here or in another company, gets the same answer", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: {} });
    const other = await seedCompany(t.db, { stranger: {} });
    const ctx = createTestContext(t.db);
    await rejectsWith(invitePerson(ctx, co.people.boss, invite({ email: co.people.ana.email.toUpperCase() })), "already_exists");
    await rejectsWith(invitePerson(ctx, co.people.boss, invite({ email: other.people.stranger.email })), "already_exists");
    await rejectsWith(invitePerson(ctx, co.people.boss, invite({ email: "not-an-email" })), "invalid_input");
    await rejectsWith(invitePerson(ctx, co.people.boss, invite({ role: "owner" })), "invalid_input");
  });

  test("an invite cannot reach into another company for a manager or department", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const other = await seedCompany(t.db, { theirs: { role: "manager" } });
    const [theirDept] = await t.db.insert(schema.departments).values({ companyId: other.companyId, name: "Theirs" }).returning();
    const ctx = createTestContext(t.db);
    await rejectsWith(invitePerson(ctx, co.people.boss, invite({ managerId: other.people.theirs.id })), "invalid_manager");
    await rejectsWith(invitePerson(ctx, co.people.boss, invite({ departmentId: theirDept.id })), "invalid_input");
  });

  test(`invites are limited to ${INVITE_LIMIT} an hour per admin, resends included; another admin is not affected`, async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, other: { role: "admin" } });
    const ctx = createTestContext(t.db);
    let last;
    for (let i = 0; i < INVITE_LIMIT - 1; i++) last = await invitePerson(ctx, co.people.boss, invite());
    await resendInvite(ctx, co.people.boss, last!.id);
    await rejectsWith(invitePerson(ctx, co.people.boss, invite()), "rate_limited");
    await rejectsWith(resendInvite(ctx, co.people.boss, last!.id), "rate_limited");
    await invitePerson(ctx, co.people.other, invite());
  });

  test("a failed sign-in link or send is logged without the address and never fails the invite", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db, {
      issueSignInLink: async () => {
        throw new Error("auth is down");
      },
    });
    const person = await invitePerson(ctx, co.people.boss, invite());
    const logged = await captureStderr(() => ctx.settle());
    const line = JSON.parse(logged.find((l) => l.includes("invite_email_failed")) ?? "{}");
    assert.equal(line.userId, person.id);
    assert.ok(!logged.join("").includes(person.email));
    assert.equal(ctx.sent.length, 0);
    assert.ok(await userRow(t.db, person.id), "the person still exists; an admin can resend");
  });

  test("resend emails a fresh link to an active person and is audited; never to a deactivated one", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: {}, gone: { isActive: false } });
    const ctx = createTestContext(t.db);
    await resendInvite(ctx, co.people.boss, co.people.ana.id);
    await ctx.settle();
    assert.deepEqual(
      ctx.sent.map((m) => [m.to, subjectOf(m)]),
      [[co.people.ana.email, INVITE_SUBJECT]],
    );
    const audit = await companyAudit(t.db, co.companyId);
    assert.deepEqual(
      audit.map((a) => [a.action, a.subjectUserId, a.after]),
      [["user.invite_resent", co.people.ana.id, { email: co.people.ana.email }]],
    );
    assert.deepEqual(
      (await companyEvents(t.db, co.companyId)).map((e) => e.type),
      ["user.invite_resent"],
    );

    await rejectsWith(resendInvite(ctx, co.people.boss, co.people.gone.id), "forbidden");
    await rejectsWith(resendInvite(ctx, co.people.ana, co.people.boss.id), "forbidden");
    const other = await seedCompany(t.db, { x: {} });
    await rejectsWith(resendInvite(ctx, co.people.boss, other.people.x.id), "not_found");
  });

  test("editing a person records exactly what changed; saving the same values records nothing", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, mgr: { role: "manager" }, ana: {} });
    const [dept] = await t.db.insert(schema.departments).values({ companyId: co.companyId, name: "Ops" }).returning();
    const ctx = createTestContext(t.db);
    const { ana } = co.people;

    const { person: edited } = await updatePerson(
      ctx,
      co.people.boss,
      ana.id,
      editOf(ana, {
        name: "Ana Smith",
        departmentId: dept.id,
        managerId: co.people.mgr.id,
        role: "manager",
        canSelfApprove: true,
      }),
    );
    assert.deepEqual(
      [edited.name, edited.departmentId, edited.managerId, edited.role, edited.canSelfApprove],
      ["Ana Smith", dept.id, co.people.mgr.id, "manager", true],
    );
    await updatePerson(
      ctx,
      co.people.boss,
      ana.id,
      editOf(edited, { departmentId: dept.id, managerId: co.people.mgr.id, role: "manager", canSelfApprove: true }),
    );

    const audit = await companyAudit(t.db, co.companyId);
    assert.equal(audit.length, 1, "the second save changed nothing");
    assert.equal(audit[0].action, "user.updated");
    assert.equal(audit[0].subjectUserId, ana.id);
    assert.deepEqual(
      [(audit[0].before as { role: string }).role, (audit[0].after as { role: string }).role, (audit[0].after as { name: string }).name],
      ["employee", "manager", "Ana Smith"],
    );
    const [event] = await companyEvents(t.db, co.companyId);
    assert.equal(event.type, "user.updated");
    assert.equal((event.payload as { managerId: string }).managerId, co.people.mgr.id);
  });

  test("edits refuse a non-admin, a person of another company, and a reporting loop", async () => {
    const co = await seedCompany(t.db, {
      boss: { role: "admin" },
      mgr: { role: "manager" },
      ana: { managerKey: "mgr" },
      gone: { isActive: false },
    });
    const other = await seedCompany(t.db, { x: {} });
    const ctx = createTestContext(t.db);
    const { boss, mgr, ana } = co.people;
    await rejectsWith(updatePerson(ctx, mgr, ana.id, editOf(ana)), "forbidden");
    await rejectsWith(updatePerson(ctx, boss, other.people.x.id, editOf(other.people.x)), "not_found");
    await rejectsWith(updatePerson(ctx, boss, mgr.id, editOf(mgr, { role: "manager", managerId: ana.id })), "manager_cycle");
    await rejectsWith(updatePerson(ctx, boss, ana.id, editOf(ana, { managerId: ana.id })), "invalid_manager");
    await rejectsWith(updatePerson(ctx, boss, ana.id, editOf(ana, { managerId: co.people.gone.id })), "invalid_manager");
    await rejectsWith(updatePerson(ctx, boss, ana.id, editOf(ana, { managerId: other.people.x.id })), "invalid_manager");
    assert.deepEqual(await companyAudit(t.db, co.companyId), []);

    const { managers } = await getPersonFormOptions(ctx, boss, mgr.id);
    assert.deepEqual(managers.map((m) => m.label).sort(), ["Boss"], "the picker leaves out mgr, ana (reports to mgr) and inactive people");

    // A deactivated current manager stays in the picker (marked), so saving other
    // fields keeps it rather than silently clearing it.
    await t.db.update(schema.user).set({ isActive: false }).where(eq(schema.user.id, mgr.id));
    const forAna = await getPersonFormOptions(ctx, boss, ana.id);
    assert.deepEqual(forAna.managers.map((m) => m.label).sort(), ["Boss", "Mgr (deactivated)"]);
    const { person: renamed } = await updatePerson(ctx, boss, ana.id, editOf(ana, { name: "Ana B", managerId: mgr.id }));
    assert.equal(renamed.managerId, mgr.id, "an unchanged inactive manager is kept");
    await rejectsWith(updatePerson(ctx, boss, co.people.gone.id, editOf(co.people.gone, { managerId: mgr.id })), "invalid_manager");
  });

  test("the last active admin cannot demote themself; with a second admin they can", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, sleepy: { role: "admin", isActive: false } });
    const ctx = createTestContext(t.db);
    const { boss } = co.people;
    await rejectsWith(updatePerson(ctx, boss, boss.id, editOf(boss, { role: "manager" })), "last_admin");
    assert.equal((await userRow(t.db, boss.id)).role, "admin", "an inactive admin does not count");

    const ctx2 = createTestContext(t.db);
    const second = await invitePerson(ctx2, boss, invite({ role: "admin" }));
    await updatePerson(ctx, boss, boss.id, editOf(boss, { role: "manager" }));
    assert.equal((await userRow(t.db, boss.id)).role, "manager");
    assert.equal((await userRow(t.db, second.id)).role, "admin");
  });

  test("two admins demoting each other at once: exactly one wins, so an admin always remains", async () => {
    const co = await seedCompany(t.db, { a1: { role: "admin" }, a2: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const { a1, a2 } = co.people;
    const results = await Promise.allSettled([
      updatePerson(ctx, a1, a2.id, editOf(a2, { role: "employee" })),
      updatePerson(ctx, a2, a1.id, editOf(a1, { role: "employee" })),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const admins = await t.db
      .select()
      .from(schema.user)
      .where(and(eq(schema.user.companyId, co.companyId), eq(schema.user.role, "admin"), eq(schema.user.isActive, true)));
    assert.equal(admins.length, 1);
  });

  test("deactivation ends sessions and feed links, reassigns pending approvals, keeps the person's own requests, and audits it all", async () => {
    const co = await seedCompany(t.db, {
      boss: { role: "admin", createdAt: "2026-01-01T00:00:00Z" },
      mgr: { role: "manager", managerKey: "boss" },
      ana: { managerKey: "mgr" },
      sam: { managerKey: "mgr", canSelfApprove: false },
    });
    const ctx = createTestContext(t.db);
    const { boss, mgr, ana } = co.people;
    await setAllowance(t.db, { userId: ana.id, leaveTypeId: co.pto, year: 2026, days: 20 });
    await setAllowance(t.db, { userId: mgr.id, leaveTypeId: co.pto, year: 2026, days: 20 });
    const anaRequest = await submitLeaveRequest(ctx, ana, { leaveTypeId: co.pto, startDate: "2026-11-16", dayPortion: "full" });
    const mgrOwn = await submitLeaveRequest(ctx, mgr, { leaveTypeId: co.pto, startDate: "2026-11-17", dayPortion: "full" });
    await issueCalendarFeed(ctx, mgr, "personal");
    await issueCalendarFeed(ctx, mgr, "team");
    await addSession(t.db, mgr.id);
    await addSession(t.db, mgr.id);
    await addSession(t.db, ana.id);
    await ctx.settle();
    ctx.sent.length = 0;
    assert.equal(anaRequest.approverId, mgr.id);

    const result = await deactivatePerson(ctx, boss, mgr.id);
    assert.deepEqual([result.sessionsRevoked, result.feedsRevoked, result.requestsReassigned], [2, 2, 1]);

    assert.equal((await userRow(t.db, mgr.id)).isActive, false);
    assert.equal((await t.db.select().from(schema.session).where(eq(schema.session.userId, mgr.id))).length, 0);
    assert.equal((await t.db.select().from(schema.session).where(eq(schema.session.userId, ana.id))).length, 1, "others keep theirs");
    const live = await t.db
      .select()
      .from(schema.calendarFeedTokens)
      .where(and(eq(schema.calendarFeedTokens.userId, mgr.id), isNull(schema.calendarFeedTokens.revokedAt)));
    assert.equal(live.length, 0);

    const [moved] = await t.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.id, anaRequest.id));
    assert.deepEqual([moved.status, moved.approverId], ["pending", boss.id], "the inactive manager is skipped: the admin takes it");
    const [own] = await t.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.id, mgrOwn.id));
    assert.deepEqual([own.status, own.approverId], [mgrOwn.status, mgrOwn.approverId], "their own request is untouched");

    const audit = await companyAudit(t.db, co.companyId);
    const sinceDeactivation = audit.slice(audit.findIndex((a) => a.action === "calendar_feed.revoked"));
    assert.deepEqual(
      sinceDeactivation.map((a) => [a.action, a.actorId, a.subjectUserId]),
      [
        ["calendar_feed.revoked", boss.id, mgr.id],
        ["calendar_feed.revoked", boss.id, mgr.id],
        ["leave_request.reassigned", boss.id, ana.id],
        ["user.deactivated", boss.id, mgr.id],
      ],
    );
    assert.deepEqual(
      [
        (sinceDeactivation[3].after as Record<string, unknown>).sessionsRevoked,
        (sinceDeactivation[3].after as Record<string, unknown>).requestsReassigned,
      ],
      [2, 1],
    );
    const events = await companyEvents(t.db, co.companyId);
    const tail = events.slice(-4);
    assert.deepEqual(
      tail.map((e) => e.type),
      ["calendar_feed.revoked", "calendar_feed.revoked", "leave.reassigned", "user.deactivated"],
    );
    assert.deepEqual((tail[0].payload as { reason: string }).reason, "deactivated");
    assert.deepEqual(
      [(tail[2].payload as { previousApproverId: string }).previousApproverId, (tail[2].payload as { approverId: string }).approverId],
      [mgr.id, boss.id],
    );

    assert.equal(ctx.sent.length, 0, "the new approver hears after commit");
    await ctx.settle();
    assert.deepEqual(
      ctx.sent.map((m) => [m.to, subjectOf(m)]),
      [[co.people.boss.email, "Time off request to review"]],
    );

    // Again: nothing more happens or is recorded.
    const again = await deactivatePerson(ctx, boss, mgr.id);
    assert.equal(again.requestsReassigned, 0);
    assert.equal((await companyAudit(t.db, co.companyId)).length, audit.length);
  });

  test("deactivating an admin reports the live API keys and webhook endpoints they created, which keep working", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, leaver: { role: "admin" }, emp: {} });
    const ctx = createTestContext(t.db);
    const { boss, leaver, emp } = co.people;
    const hook = { description: "", eventTypes: ["leave.requested"] };
    const kept = await createApiKey(ctx, leaver, { name: "Payroll" });
    const revoked = await createApiKey(ctx, leaver, { name: "Old" });
    await revokeApiKey(ctx, leaver, revoked.apiKey.id);
    await createApiKey(ctx, boss, { name: "Boss's own" });
    await createWebhookEndpoint(ctx, leaver, { ...hook, url: "https://hooks.example.com/a" });
    const gone = await createWebhookEndpoint(ctx, leaver, { ...hook, url: "https://hooks.example.com/b" });
    await deleteWebhookEndpoint(ctx, leaver, gone.endpoint.id);
    await createWebhookEndpoint(ctx, boss, { ...hook, url: "https://hooks.example.com/c" });

    const result = await deactivatePerson(ctx, boss, leaver.id);
    assert.deepEqual([result.liveApiKeysCreated, result.liveWebhookEndpointsCreated], [1, 1], "only theirs, only live ones");
    const [key] = await t.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, kept.apiKey.id));
    assert.equal(key.revokedAt, null, "company keys are not revoked by a deactivation");
    assert.deepEqual(
      [
        (await deactivatePerson(ctx, boss, leaver.id)).liveApiKeysCreated,
        (await deactivatePerson(ctx, boss, leaver.id)).liveWebhookEndpointsCreated,
      ],
      [1, 1],
      "still reported when done again",
    );

    // Paired: someone who created nothing reports nothing.
    const plain = await deactivatePerson(ctx, boss, emp.id);
    assert.deepEqual([plain.liveApiKeysCreated, plain.liveWebhookEndpointsCreated], [0, 0]);
  });

  test("demoting an admin moves the requests they only had as admin; those they manage stay", async () => {
    const co = await seedCompany(t.db, {
      a1: { role: "admin", createdAt: "2025-01-01T00:00:00Z" },
      a2: { role: "admin", createdAt: "2026-01-01T00:00:00Z" },
      emp: {},
      ana: { managerKey: "a1" },
    });
    const ctx = createTestContext(t.db);
    const { a1, a2, emp, ana } = co.people;
    for (const p of [emp, ana]) await setAllowance(t.db, { userId: p.id, leaveTypeId: co.pto, year: 2026, days: 20 });
    const empRequest = await submitLeaveRequest(ctx, emp, { leaveTypeId: co.pto, startDate: "2026-11-16", dayPortion: "full" });
    const anaRequest = await submitLeaveRequest(ctx, ana, { leaveTypeId: co.pto, startDate: "2026-11-17", dayPortion: "full" });
    assert.deepEqual([empRequest.approverId, anaRequest.approverId], [a1.id, a1.id], "no manager: the longest-standing admin");
    await ctx.settle();
    ctx.sent.length = 0;

    const { requestsReassigned } = await updatePerson(ctx, a2, a1.id, editOf(a1, { role: "employee" }));
    assert.equal(requestsReassigned, 1);
    const demoted: Actor = { ...a1, role: "employee" };
    await rejectsWith(decideLeaveRequest(ctx, demoted, { requestId: empRequest.id, decision: "approve" }), "forbidden");
    const inboxOf = async (actor: Actor) => (await decidable(ctx, actor)).items.map((i) => i.id).sort();
    assert.deepEqual(await inboxOf(demoted), [anaRequest.id], "they still decide for the person they manage");
    assert.ok((await inboxOf(a2)).includes(empRequest.id));
    const [moved] = await t.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.id, empRequest.id));
    assert.deepEqual([moved.status, moved.approverId], ["pending", a2.id]);

    const audit = (await companyAudit(t.db, co.companyId)).slice(-2);
    assert.deepEqual(
      audit.map((a) => [a.action, a.actorId, a.entityId]),
      [
        ["user.updated", a2.id, a1.id],
        ["leave_request.reassigned", a2.id, empRequest.id],
      ],
    );
    const events = (await companyEvents(t.db, co.companyId)).slice(-2);
    assert.deepEqual(
      events.map((e) => e.type),
      ["user.updated", "leave.reassigned"],
    );
    assert.deepEqual(
      [(events[1].payload as { previousApproverId: string }).previousApproverId, (events[1].payload as { approverId: string }).approverId],
      [a1.id, a2.id],
    );
    await ctx.settle();
    assert.deepEqual(
      ctx.sent.map((m) => [m.to, subjectOf(m)]),
      [[a2.email, "Time off request to review"]],
    );

    await decideLeaveRequest(ctx, a2, { requestId: empRequest.id, decision: "approve" });
  });

  test("changing someone's manager moves their pending requests to the new manager; a rename moves nothing", async () => {
    const co = await seedCompany(t.db, {
      boss: { role: "admin" },
      alice: { role: "manager" },
      carol: { role: "manager" },
      ena: { managerKey: "alice" },
    });
    const ctx = createTestContext(t.db);
    const { boss, alice, carol, ena } = co.people;
    await setAllowance(t.db, { userId: ena.id, leaveTypeId: co.pto, year: 2026, days: 20 });
    const request = await submitLeaveRequest(ctx, ena, { leaveTypeId: co.pto, startDate: "2026-11-16", dayPortion: "full" });
    assert.equal(request.approverId, alice.id);

    const renamed = await updatePerson(ctx, boss, ena.id, editOf(ena, { name: "Ena B", managerId: alice.id }));
    assert.equal(renamed.requestsReassigned, 0, "the same manager: nothing moves");

    const changed = await updatePerson(ctx, boss, ena.id, editOf(ena, { name: "Ena B", managerId: carol.id }));
    assert.equal(changed.requestsReassigned, 1);
    await rejectsWith(decideLeaveRequest(ctx, alice, { requestId: request.id, decision: "approve" }), "forbidden");
    assert.deepEqual((await decidable(ctx, alice)).items, [], "the old manager no longer sees it");
    assert.deepEqual(
      (await decidable(ctx, carol)).items.map((i) => i.id),
      [request.id],
    );
    const decided = await decideLeaveRequest(ctx, carol, { requestId: request.id, decision: "approve" });
    assert.equal(decided.status, "approved");
    assert.deepEqual(
      (await companyAudit(t.db, co.companyId, "leave_request.reassigned")).map((a) => [
        (a.before as { approverId: string }).approverId,
        (a.after as { approverId: string }).approverId,
      ]),
      [[alice.id, carol.id]],
    );
  });

  describe("a request an only admin routed to themself", () => {
    /** An only admin `boss` with a pending request routed to themself, plus `others`. */
    async function selfRouted(others: Record<string, PersonSpec> = {}) {
      const co = await seedCompany(t.db, { boss: { role: "admin", createdAt: "2025-01-01T00:00:00Z" }, ...others });
      const ctx = createTestContext(t.db);
      await setAllowance(t.db, { userId: co.people.boss.id, leaveTypeId: co.pto, year: 2026, days: 20 });
      const request = await submitLeaveRequest(ctx, co.people.boss, { leaveTypeId: co.pto, startDate: "2026-11-16", dayPortion: "full" });
      assert.equal(request.approverId, co.people.boss.id);
      await ctx.settle();
      ctx.sent.length = 0;
      return { co, ctx, request };
    }
    const approverOf = async (id: string) =>
      (await t.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.id, id)))[0].approverId;

    test("moves to their new manager, and they can no longer decide it", async () => {
      const { co, ctx, request } = await selfRouted({ mgr: { role: "manager" } });
      const { boss, mgr } = co.people;
      const { requestsReassigned } = await updatePerson(ctx, boss, boss.id, editOf(boss, { role: "admin", managerId: mgr.id }));
      assert.equal(requestsReassigned, 1);
      assert.equal(await approverOf(request.id), mgr.id);
      await rejectsWith(decideLeaveRequest(ctx, boss, { requestId: request.id, decision: "approve" }), "forbidden");
      const reassigned = await companyAudit(t.db, co.companyId, "leave_request.reassigned");
      assert.deepEqual(
        reassigned.map((a) => [a.actorId, a.entityId]),
        [[boss.id, request.id]],
      );
      await ctx.settle();
      assert.deepEqual(
        ctx.sent.map((m) => [m.to, subjectOf(m)]),
        [[mgr.email, "Time off request to review"]],
      );
      assert.equal((await decideLeaveRequest(ctx, mgr, { requestId: request.id, decision: "approve" })).status, "approved");
    });

    test("stays with them when a manager change leaves nobody else to take it", async () => {
      // Their manager left, so the request fell back to them; clearing the manager changes nothing.
      const { co, ctx, request } = await selfRouted({ mgr: { role: "manager", isActive: false } });
      const { boss, mgr } = co.people;
      await t.db.update(schema.user).set({ managerId: mgr.id }).where(eq(schema.user.id, boss.id));
      const { requestsReassigned } = await updatePerson(ctx, boss, boss.id, editOf(boss, { role: "admin", managerId: null }));
      assert.equal(requestsReassigned, 0);
      assert.equal(await approverOf(request.id), boss.id);
      assert.deepEqual(await companyAudit(t.db, co.companyId, "leave_request.reassigned"), []);
      assert.equal((await decideLeaveRequest(ctx, boss, { requestId: request.id, decision: "approve" })).status, "approved");
    });

    test("moves to a second admin when one is promoted or invited", async () => {
      const promoted = await selfRouted({ b: {} });
      const { boss, b } = promoted.co.people;
      const { requestsReassigned } = await updatePerson(promoted.ctx, boss, b.id, editOf(b, { role: "admin" }));
      assert.equal(requestsReassigned, 1);
      assert.equal(await approverOf(promoted.request.id), b.id);
      await rejectsWith(decideLeaveRequest(promoted.ctx, boss, { requestId: promoted.request.id, decision: "approve" }), "forbidden");
      await promoted.ctx.settle();
      assert.deepEqual(
        promoted.ctx.sent.map((m) => [m.to, subjectOf(m)]),
        [[b.email, "Time off request to review"]],
      );

      const invited = await selfRouted();
      const admin = await invitePerson(invited.ctx, invited.co.people.boss, invite({ role: "admin" }));
      assert.equal(await approverOf(invited.request.id), admin.id);
      const reassigned = await companyEvents(t.db, invited.co.companyId, "leave.reassigned");
      assert.deepEqual(
        reassigned.map((e) => (e.payload as { approverId: string }).approverId),
        [admin.id],
      );
      await invited.ctx.settle();
      assert.deepEqual(
        invited.ctx.sent.map((m) => [m.to, subjectOf(m)]).sort(),
        [
          [admin.email, INVITE_SUBJECT],
          [admin.email, "Time off request to review"],
        ].sort(),
      );

      // Its pair: inviting or promoting a non-admin moves nothing.
      const unchanged = await selfRouted({ c: {} });
      await invitePerson(unchanged.ctx, unchanged.co.people.boss, invite({ role: "manager" }));
      const edit = await updatePerson(
        unchanged.ctx,
        unchanged.co.people.boss,
        unchanged.co.people.c.id,
        editOf(unchanged.co.people.c, { role: "manager" }),
      );
      assert.equal(edit.requestsReassigned, 0);
      assert.equal(await approverOf(unchanged.request.id), unchanged.co.people.boss.id);
    });

    test("moves back to their manager when the manager is reactivated", async () => {
      const co = await seedCompany(t.db, { boss: { role: "admin" }, mgr: { role: "manager" } });
      const ctx = createTestContext(t.db);
      const { boss, mgr } = co.people;
      await t.db.update(schema.user).set({ managerId: mgr.id }).where(eq(schema.user.id, boss.id));
      await setAllowance(t.db, { userId: boss.id, leaveTypeId: co.pto, year: 2026, days: 20 });
      const request = await submitLeaveRequest(ctx, boss, { leaveTypeId: co.pto, startDate: "2026-11-16", dayPortion: "full" });
      assert.equal(request.approverId, mgr.id);

      await deactivatePerson(ctx, boss, mgr.id);
      assert.equal(await approverOf(request.id), boss.id, "nobody else: back to the only admin");
      await reactivatePerson(ctx, boss, mgr.id);
      assert.equal(await approverOf(request.id), mgr.id);
      await rejectsWith(decideLeaveRequest(ctx, boss, { requestId: request.id, decision: "approve" }), "forbidden");
      assert.deepEqual(
        (await companyAudit(t.db, co.companyId)).map((a) => a.action).filter((a) => a !== "leave_request.requested"),
        ["leave_request.reassigned", "user.deactivated", "user.reactivated", "leave_request.reassigned"],
      );
    });

    test("demoting its requester moves it, even if they were left assigned to it", async () => {
      // A second admin arrived without a re-route (simulated with a raw write).
      const { co, ctx, request } = await selfRouted({ b: { createdAt: "2026-01-01T00:00:00Z" } });
      const { boss, b } = co.people;
      await t.db.update(schema.user).set({ role: "admin" }).where(eq(schema.user.id, b.id));
      const admin = { ...b, role: "admin" as const };
      const { requestsReassigned } = await updatePerson(ctx, admin, boss.id, editOf(boss, { role: "employee" }));
      assert.equal(requestsReassigned, 1);
      assert.equal(await approverOf(request.id), b.id);
      await rejectsWith(
        decideLeaveRequest(ctx, { ...boss, role: "employee" }, { requestId: request.id, decision: "approve" }),
        "forbidden",
      );
    });
  });

  test("deactivating an approver costs a fixed number of reads, whatever the number of requests that move", async () => {
    /** Deactivates a manager with `reports` reports, each with one pending request; returns the statements it ran. */
    const statementsFor = async (reports: number) => {
      const specs: Record<string, PersonSpec> = { boss: { role: "admin" }, mgr: { role: "manager" } };
      for (let i = 0; i < reports; i++) specs[`p${i}`] = { managerKey: "mgr" };
      const co = await seedCompany(t.db, specs);
      const ctx = createTestContext(t.db);
      for (let i = 0; i < reports; i++) {
        const p = co.people[`p${i}`];
        await setAllowance(t.db, { userId: p.id, leaveTypeId: co.pto, year: 2026, days: 20 });
        await submitLeaveRequest(ctx, p, { leaveTypeId: co.pto, startDate: "2026-11-16", dayPortion: "full" });
      }
      let queries = 0;
      const counting = t.withLogger({ logQuery: () => void queries++ });
      const { requestsReassigned } = await deactivatePerson(createTestContext(counting), co.people.boss, co.people.mgr.id);
      assert.equal(requestsReassigned, reports);
      return queries;
    };
    const one = await statementsFor(1);
    const five = await statementsFor(5);
    // Each moved request costs its compare-and-set update, its audit row and its outbox
    // row; every read is shared.
    assert.equal(five - one, 4 * 3);
  });

  test("deactivation refuses the admin themself, non-admins and other companies", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, other: { role: "admin" }, ana: {} });
    const elsewhere = await seedCompany(t.db, { x: {} });
    const ctx = createTestContext(t.db);
    await rejectsWith(deactivatePerson(ctx, co.people.boss, co.people.boss.id), "self_change_not_allowed");
    await rejectsWith(deactivatePerson(ctx, co.people.ana, co.people.other.id), "forbidden");
    await rejectsWith(deactivatePerson(ctx, co.people.boss, elsewhere.people.x.id), "not_found");
    assert.deepEqual(await companyAudit(t.db, co.companyId), []);
    // Another admin can deactivate an admin while one remains.
    await deactivatePerson(ctx, co.people.boss, co.people.other.id);
    assert.equal((await userRow(t.db, co.people.other.id)).isActive, false);
  });

  test("reactivation lets them back in; turned-off feed links stay off", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: {} });
    const ctx = createTestContext(t.db);
    await issueCalendarFeed(ctx, co.people.ana, "personal");
    await deactivatePerson(ctx, co.people.boss, co.people.ana.id);
    await rejectsWith(reactivatePerson(ctx, co.people.ana as Actor, co.people.ana.id), "forbidden");
    const back = await reactivatePerson(ctx, co.people.boss, co.people.ana.id);
    assert.equal(back.isActive, true);
    await reactivatePerson(ctx, co.people.boss, co.people.ana.id);
    const live = await t.db
      .select()
      .from(schema.calendarFeedTokens)
      .where(and(eq(schema.calendarFeedTokens.userId, co.people.ana.id), isNull(schema.calendarFeedTokens.revokedAt)));
    assert.equal(live.length, 0);
    const actions = (await companyAudit(t.db, co.companyId, "user.")).map((a) => a.action);
    assert.deepEqual(actions, ["user.deactivated", "user.reactivated"], "the second reactivate records nothing");
    assert.deepEqual(
      (await companyEvents(t.db, co.companyId, "user.")).map((e) => e.type),
      actions,
    );
  });

  test("the list filters by text and status, scoped to the company; the detail shows the person's balances", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" }, ben: {}, gone: { isActive: false } });
    const other = await seedCompany(t.db, { anastasia: {} });
    const ctx = createTestContext(t.db);
    const names = async (filter: Parameters<typeof listPeople>[2]) =>
      (await listPeople(ctx, co.people.boss, filter)).people.map((p) => p.name);
    assert.deepEqual(await names({ status: "active" }), ["Ana", "Ben", "Boss"]);
    assert.deepEqual(await names({ status: "inactive" }), ["Gone"]);
    assert.deepEqual(await names({ status: "all", query: "AN" }), ["Ana"]);
    assert.deepEqual(await names({ status: "all", query: "%" }), [], "wildcards are literal");
    const [ana] = (await listPeople(ctx, co.people.boss, { status: "all", query: "ana" })).people;
    assert.equal(ana.managerName, "Boss");
    await rejectsWith(listPeople(ctx, co.people.ana, { status: "all" }), "forbidden");

    await setAllowance(t.db, { userId: co.people.ana.id, leaveTypeId: co.pto, year: 2026, days: 12, adjustmentDays: 1 });
    const detail = await getPersonDetail(ctx, co.people.boss, co.people.ana.id);
    assert.equal(detail.year, 2026);
    assert.deepEqual(
      detail.balances?.items.map((i) => [i.name, i.balance.tracked && i.balance.remaining, i.row?.days]),
      [["PTO", 13, 12]],
    );
    await rejectsWith(getPersonDetail(ctx, co.people.boss, other.people.anastasia.id), "not_found");
    await rejectsWith(getPersonDetail(ctx, co.people.ana, co.people.ana.id), "forbidden");
  });
});
