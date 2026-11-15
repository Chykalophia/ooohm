import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { getAccount as getAccountResult, renameSelf, setColorMode as setColorModeResult } from "@/modules/people";
import { rejectsWith } from "./assertions";
import { companyAudit, companyEvents, seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";
import { unwrap } from "@/shared/lib/result";
import { first } from "../support/present";

const getAccount = (...args: Parameters<typeof getAccountResult>) => getAccountResult(...args).then(unwrap);
const setColorMode = (...args: Parameters<typeof setColorModeResult>) => setColorModeResult(...args).then(unwrap);

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
    const ops = first(await t.db.insert(schema.departments).values({ companyId: co.companyId, name: "Ops" }).returning());
    await t.db.update(schema.user).set({ departmentId: ops.id }).where(eq(schema.user.id, co.people.ana.id));
    const ctx = createTestContext(t.db);

    assert.deepEqual(await getAccount(ctx, co.people.ana), {
      name: "Ana",
      email: co.people.ana.email,
      role: "employee",
      department: "Ops",
      manager: "Boss",
      passkeys: [],
      timezone: "America/Chicago",
    });
    const boss = await getAccount(ctx, co.people.boss);
    assert.deepEqual([boss.role, boss.department, boss.manager], ["admin", null, null]);
  });

  test("a person renames themself, audited as their own user.updated; nothing else changes", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" } });
    const ctx = createTestContext(t.db);
    const { ana } = co.people;

    assert.equal(unwrap(await renameSelf(ctx, ana, "  Ana   Test ")), "Ana Test");
    assert.equal((await getAccount(ctx, ana)).name, "Ana Test");
    assert.equal(unwrap(await renameSelf(ctx, ana, "Ana Test")), "Ana Test", "the same name again");

    const audit = await companyAudit(t.db, co.companyId, "user.updated");
    assert.equal(audit.length, 1, "saving the same name records nothing");
    assert.equal(first(audit).actorId, ana.id, "the person is the actor");
    assert.equal(first(audit).subjectUserId, ana.id);
    assert.deepEqual([(first(audit).before as { name: string }).name, (first(audit).after as { name: string }).name], ["Ana", "Ana Test"]);
    assert.deepEqual(first(audit).after, { ...(first(audit).before as object), name: "Ana Test" }, "only the name changed");
    assert.deepEqual(await getAccount(ctx, ana), {
      name: "Ana Test",
      email: ana.email,
      role: "employee",
      department: null,
      manager: "Boss",
      passkeys: [],
      timezone: "America/Chicago",
    });
    const event = first(await companyEvents(t.db, co.companyId, "user.updated"));
    assert.deepEqual((event.payload as { actor: unknown }).actor, { type: "user", id: ana.id });
  });

  test("a blank or too long name is refused, and so is a deactivated account", async () => {
    const co = await seedCompany(t.db, { ana: {}, gone: { isActive: false } });
    const ctx = createTestContext(t.db);
    await rejectsWith(renameSelf(ctx, co.people.ana, "   ").then(unwrap), "invalid_input");
    await rejectsWith(renameSelf(ctx, co.people.ana, "x".repeat(101)).then(unwrap), "invalid_input");
    await rejectsWith(renameSelf(ctx, co.people.gone, "Back").then(unwrap), "forbidden");
    assert.deepEqual(await companyAudit(t.db, co.companyId), []);
  });

  test("a person's colour mode starts light and changes for them alone, with nothing audited or sent", async () => {
    const co = await seedCompany(t.db, { ana: {}, bo: {} });
    const other = await seedCompany(t.db, { cy: {} });
    const ctx = createTestContext(t.db);
    const modeOf = async (id: string) =>
      first(await t.db.select({ mode: schema.user.colorMode }).from(schema.user).where(eq(schema.user.id, id))).mode;

    assert.equal(await modeOf(co.people.ana.id), "light", "the default");
    await setColorMode(ctx, co.people.ana, "dark");
    assert.deepEqual(
      [await modeOf(co.people.ana.id), await modeOf(co.people.bo.id), await modeOf(other.people.cy.id)],
      ["dark", "light", "light"],
    );
    await setColorMode(ctx, co.people.ana, "system");
    assert.equal(await modeOf(co.people.ana.id), "system");

    assert.deepEqual(await companyAudit(t.db, co.companyId), [], "a display preference is not audited");
    assert.deepEqual(await companyEvents(t.db, co.companyId), [], "nor sent to integrations");
  });

  test("a deactivated account cannot change its colour mode, and an actor naming another company changes nothing", async () => {
    const co = await seedCompany(t.db, { ana: {}, gone: { isActive: false } });
    const other = await seedCompany(t.db, { cy: {} });
    const ctx = createTestContext(t.db);
    await rejectsWith(setColorMode(ctx, co.people.gone, "dark"), "forbidden");
    await rejectsWith(setColorMode(ctx, { ...co.people.ana, companyId: other.companyId }, "dark"), "forbidden");
    const rows = await t.db.select({ mode: schema.user.colorMode }).from(schema.user).where(eq(schema.user.companyId, co.companyId));
    assert.deepEqual(
      rows.map((r) => r.mode),
      ["light", "light"],
    );
  });
});
