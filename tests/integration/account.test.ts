import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { getAccount, renameSelf } from "@/server/services/account";
import { rejectsWith } from "./assertions";
import { companyAudit, companyEvents, seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

describe("your account", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  test("shows the person's own details: role, department and manager by name", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" } });
    const [ops] = await t.db.insert(schema.departments).values({ companyId: co.companyId, name: "Ops" }).returning();
    await t.db.update(schema.user).set({ departmentId: ops.id }).where(eq(schema.user.id, co.people.ana.id));
    const ctx = createTestContext(t.db);

    assert.deepEqual(await getAccount(ctx, co.people.ana), {
      name: "Ana",
      email: co.people.ana.email,
      role: "employee",
      department: "Ops",
      manager: "Boss",
    });
    const boss = await getAccount(ctx, co.people.boss);
    assert.deepEqual([boss.role, boss.department, boss.manager], ["admin", null, null]);
  });

  test("a person renames themself, audited as their own user.updated; nothing else changes", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" } });
    const ctx = createTestContext(t.db);
    const { ana } = co.people;

    assert.equal(await renameSelf(ctx, ana, "  Ana   Test "), "Ana Test");
    assert.equal((await getAccount(ctx, ana)).name, "Ana Test");
    assert.equal(await renameSelf(ctx, ana, "Ana Test"), "Ana Test", "the same name again");

    const audit = await companyAudit(t.db, co.companyId, "user.updated");
    assert.equal(audit.length, 1, "saving the same name records nothing");
    assert.equal(audit[0].actorId, ana.id, "the person is the actor");
    assert.equal(audit[0].subjectUserId, ana.id);
    assert.deepEqual([(audit[0].before as { name: string }).name, (audit[0].after as { name: string }).name], ["Ana", "Ana Test"]);
    assert.deepEqual((audit[0].after as { role: string; managerId: string }).role, "employee");
    const [event] = await companyEvents(t.db, co.companyId, "user.updated");
    assert.deepEqual((event.payload as { actor: unknown }).actor, { type: "user", id: ana.id });
  });

  test("a blank or too long name is refused, and so is a deactivated account", async () => {
    const co = await seedCompany(t.db, { ana: {}, gone: { isActive: false } });
    const ctx = createTestContext(t.db);
    await rejectsWith(renameSelf(ctx, co.people.ana, "   "), "invalid_input");
    await rejectsWith(renameSelf(ctx, co.people.ana, "x".repeat(101)), "invalid_input");
    await rejectsWith(renameSelf(ctx, co.people.gone, "Back"), "forbidden");
    assert.deepEqual(await companyAudit(t.db, co.companyId), []);
  });
});
