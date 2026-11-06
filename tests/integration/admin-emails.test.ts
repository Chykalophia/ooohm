import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { getEmailForAdmin, listEmailsForAdmin, previewEmail, resetEmailCopy, saveEmailCopy } from "@/server/services/admin-emails";
import { submitLeaveRequest } from "@/server/services/leave-requests";
import { invitePerson } from "@/server/services/admin-people";
import { rejectsWith } from "./assertions";
import { companyAudit, companyEvents, seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

describe("admin: email copy", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  test("only admins see or change the emails", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, mo: { role: "manager" } });
    const ctx = createTestContext(t.db);
    const { mo } = co.people;
    await rejectsWith(listEmailsForAdmin(ctx, mo), "forbidden");
    await rejectsWith(getEmailForAdmin(ctx, mo, "leave.requested"), "forbidden");
    await rejectsWith(saveEmailCopy(ctx, mo, "leave.requested", { subject: "Hi", message: "" }), "forbidden");
    await rejectsWith(previewEmail(ctx, mo, "leave.requested", { subject: "", message: "" }), "forbidden");
    await rejectsWith(resetEmailCopy(ctx, mo, "leave.requested"), "forbidden");
  });

  test("every email is listed with its defaults, and an unknown email is not found", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const { boss } = co.people;
    const list = await listEmailsForAdmin(ctx, boss);
    assert.equal(list[0].type, "leave.requested");
    assert.ok(list.some((e) => e.type === "invite"));
    assert.ok(list.every((e) => !e.customized && e.label && e.description));

    const email = await getEmailForAdmin(ctx, boss, "leave.requested");
    assert.equal(email.saved, null);
    assert.equal(email.defaults.subject, "{{requester}} asked for {{date_span}}");
    assert.ok(email.variables.some((v) => v.name === "requester"));
    await rejectsWith(getEmailForAdmin(ctx, boss, "leave.nope"), "not_found");
    await rejectsWith(saveEmailCopy(ctx, boss, "constructor", { subject: "x", message: "" }), "not_found");
  });

  test("saving copy is audited and evented; saving it again changes nothing; reset brings the default back", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const { boss } = co.people;

    const saved = await saveEmailCopy(ctx, boss, "leave.approved", { subject: "  Enjoy, {{requester}}! ", message: "" });
    assert.deepEqual(saved, { subject: "Enjoy, {{requester}}!", message: null });
    await saveEmailCopy(ctx, boss, "leave.approved", { subject: "Enjoy, {{requester}}!", message: "" });
    assert.equal((await listEmailsForAdmin(ctx, boss)).find((e) => e.type === "leave.approved")?.customized, true);

    await resetEmailCopy(ctx, boss, "leave.approved");
    await resetEmailCopy(ctx, boss, "leave.approved");
    assert.equal((await getEmailForAdmin(ctx, boss, "leave.approved")).saved, null);

    const audit = await companyAudit(t.db, co.companyId, "email_template.");
    assert.deepEqual(
      audit.map((a) => [a.action, a.actorId, a.entityId, a.before, a.after]),
      [
        ["email_template.updated", boss.id, "leave.approved", null, { subject: "Enjoy, {{requester}}!", message: null }],
        ["email_template.reset", boss.id, "leave.approved", { subject: "Enjoy, {{requester}}!", message: null }, null],
      ],
    );
    const events = await companyEvents(t.db, co.companyId, "email_template.");
    assert.deepEqual(events.map((e) => e.type), ["email_template.updated", "email_template.reset"]);
    assert.deepEqual(events[0].payload, {
      notificationType: "leave.approved",
      subject: "Enjoy, {{requester}}!",
      message: null,
      actorId: boss.id,
      actor: { type: "user", id: boss.id },
    });
  });

  test("saving the defaults, or blanks, stores nothing", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const { boss } = co.people;
    const email = await getEmailForAdmin(ctx, boss, "leave.rejected");
    assert.deepEqual(await saveEmailCopy(ctx, boss, "leave.rejected", email.defaults), { subject: null, message: null });
    assert.deepEqual(await saveEmailCopy(ctx, boss, "leave.rejected", { subject: " ", message: "" }), { subject: null, message: null });
    assert.equal((await companyAudit(t.db, co.companyId, "email_template.")).length, 0);
  });

  test("copy with a variable the email does not have is refused, naming the field", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const { boss } = co.people;
    await assert.rejects(saveEmailCopy(ctx, boss, "leave.approved", { subject: "", message: "Added by {{added_by}}" }), (err: unknown) => {
      const e = err as { code?: string; details?: { field?: string } };
      return e.code === "invalid_input" && e.details?.field === "message";
    });
    await rejectsWith(previewEmail(ctx, boss, "invite", { subject: "{{dates}}", message: "" }), "invalid_input");
  });

  test("the preview renders the draft with sample data and the company's accent, and saves nothing", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const { boss } = co.people;
    await t.db.update(schema.companies).set({ accentColor: "#c026d3" }).where(eq(schema.companies.id, co.companyId));
    const preview = await previewEmail(ctx, boss, "leave.requested", { subject: "Request from {{requester}}", message: "" });
    assert.equal(preview.subject, "Request from Ana Ruiz");
    assert.match(preview.html, /Ana Ruiz asked for <b style="font-weight:600">PTO<\/b>/);
    assert.match(preview.html, /#c026d3/i);
    assert.equal((await getEmailForAdmin(ctx, boss, "leave.requested")).saved, null);
    assert.equal(ctx.sent.length, 0);

    const invite = await previewEmail(ctx, boss, "invite", { subject: "", message: "" });
    assert.equal(invite.subject, "You're invited to OOOhm");
    assert.equal(ctx.signInLinks.length, 0, "a preview issues no sign-in link");
  });

  test("emails go out with the company's copy, and another company's copy never applies", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, mo: { role: "manager" }, ana: { managerKey: "mo" } });
    const other = await seedCompany(t.db, { admin: { role: "admin" }, zed: { role: "manager" }, kim: { managerKey: "zed" } });
    const ctx = createTestContext(t.db);
    await saveEmailCopy(ctx, co.people.boss, "leave.requested", {
      subject: "Leave request: {{requester}}",
      message: "{{requester}} would like {{leave_type}} on {{dates}}.\n\nPlease answer within two days.",
    });
    await saveEmailCopy(ctx, co.people.boss, "invite", { subject: "Welcome to {{company}}", message: "" });

    const input = { leaveTypeId: co.pto, startDate: "2026-11-23", endDate: "2026-11-24", dayPortion: "full" as const, note: null };
    await submitLeaveRequest(ctx, co.people.ana, input);
    await submitLeaveRequest(ctx, other.people.kim, { ...input, leaveTypeId: other.pto });
    await ctx.settle();

    const ours = ctx.sent.find((m) => m.to === co.people.mo.email);
    assert.equal(ours?.subject, "Leave request: Ana");
    assert.match(ours?.text ?? "", /^Ana would like PTO on Mon, Nov 23 to Tue, Nov 24, 2026\.\n\n[\s\S]*Please answer within two days\./);
    const theirs = ctx.sent.find((m) => m.to === other.people.zed.email);
    assert.match(theirs?.subject ?? "", /^Kim asked for /);

    await invitePerson(ctx, co.people.boss, { email: "new.person@example.com", name: "New Person", role: "employee", departmentId: null, managerId: null, canSelfApprove: false });
    await ctx.settle();
    const company = await t.db.query.companies.findFirst({ where: (c, { eq }) => eq(c.id, co.companyId) });
    assert.equal(ctx.sent.find((m) => m.to === "new.person@example.com")?.subject, `Welcome to ${company?.name}`);
  });
});
