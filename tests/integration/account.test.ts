import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { getAccount, renameSelf, setTheme } from "@/server/services/account";
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
    assert.deepEqual(audit[0].after, { ...(audit[0].before as object), name: "Ana Test" }, "only the name changed");
    assert.deepEqual(await getAccount(ctx, ana), {
      name: "Ana Test",
      email: ana.email,
      role: "employee",
      department: null,
      manager: "Boss",
    });
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

  test("a person's theme starts light and changes for them alone, with nothing audited or sent", async () => {
    const co = await seedCompany(t.db, { ana: {}, bo: {} });
    const other = await seedCompany(t.db, { cy: {} });
    const ctx = createTestContext(t.db);
    const themeOf = async (id: string) =>
      (await t.db.select({ theme: schema.user.theme }).from(schema.user).where(eq(schema.user.id, id)))[0].theme;

    assert.equal(await themeOf(co.people.ana.id), "light", "the default");
    await setTheme(ctx, co.people.ana, "dark");
    assert.deepEqual(
      [await themeOf(co.people.ana.id), await themeOf(co.people.bo.id), await themeOf(other.people.cy.id)],
      ["dark", "light", "light"],
    );
    await setTheme(ctx, co.people.ana, "system");
    assert.equal(await themeOf(co.people.ana.id), "system");

    assert.deepEqual(await companyAudit(t.db, co.companyId), [], "a display preference is not audited");
    assert.deepEqual(await companyEvents(t.db, co.companyId), [], "nor sent to integrations");
  });

  test("a deactivated account cannot change its theme, and an actor naming another company changes nothing", async () => {
    const co = await seedCompany(t.db, { ana: {}, gone: { isActive: false } });
    const other = await seedCompany(t.db, { cy: {} });
    const ctx = createTestContext(t.db);
    await rejectsWith(setTheme(ctx, co.people.gone, "dark"), "forbidden");
    await rejectsWith(setTheme(ctx, { ...co.people.ana, companyId: other.companyId }, "dark"), "forbidden");
    const rows = await t.db.select({ theme: schema.user.theme }).from(schema.user).where(eq(schema.user.companyId, co.companyId));
    assert.deepEqual(
      rows.map((r) => r.theme),
      ["light", "light"],
    );
  });
});
