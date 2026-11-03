import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as schema from "@/db/schema";
import { isDomainError } from "@/domain/errors";
import { installStatus, isSetupOpen, runFirstInstall } from "@/server/services/install";
import { seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

const TOKEN = "a".repeat(40);
const input = (over: Partial<Parameters<typeof runFirstInstall>[1]> = {}) => ({
  token: TOKEN,
  companyName: "Chykalophia",
  timezone: "America/Chicago",
  adminName: "Peter",
  adminEmail: "Peter@Chykalophia.com",
  ...over,
});

/** Every test gets an empty database of its own: setup only ever runs on one. */
async function withEmptyDatabase(work: (t: TestDatabase) => Promise<void>) {
  const t = await createTestDatabase();
  try {
    await work(t);
  } finally {
    await t.drop();
  }
}

async function counts(t: TestDatabase) {
  const [companies, people, types, marker, audit] = await Promise.all([
    t.db.select().from(schema.companies),
    t.db.select().from(schema.user),
    t.db.select().from(schema.leaveTypes),
    t.db.select().from(schema.installation),
    t.db.select().from(schema.auditLog),
  ]);
  return { companies, people, types, marker, audit };
}

const refusedWith = (code: string) => (err: unknown) => isDomainError(err, code as never);

describe("first install", { skip }, () => {
  test("a wrong token, or none configured, is refused and writes nothing", async () => {
    await withEmptyDatabase(async (t) => {
      const ctx = createTestContext(t.db);
      await assert.rejects(runFirstInstall(ctx, input({ token: "b".repeat(40) }), TOKEN), refusedWith("forbidden"));
      await assert.rejects(runFirstInstall(ctx, input(), undefined), refusedWith("forbidden"), "no SETUP_TOKEN: setup is off");
      await assert.rejects(runFirstInstall(ctx, input({ token: "" }), TOKEN), refusedWith("forbidden"));
      const after = await counts(t);
      assert.deepEqual([after.companies.length, after.people.length, after.marker.length], [0, 0, 0]);
      assert.equal(await installStatus(ctx, undefined), "off");
      assert.equal(await installStatus(ctx, TOKEN), "open");
    });
  });

  test("the right token creates the company, PTO-first leave types and the first admin, audited, then closes for good", async () => {
    await withEmptyDatabase(async (t) => {
      const ctx = createTestContext(t.db);
      assert.deepEqual(await runFirstInstall(ctx, input(), TOKEN), { email: "peter@chykalophia.com" });

      const { companies, people, types, marker, audit } = await counts(t);
      assert.deepEqual(
        companies.map((c) => [c.name, c.timezone]),
        [["Chykalophia", "America/Chicago"]],
      );
      assert.deepEqual(
        people.map((p) => [p.email, p.name, p.role, p.canSelfApprove, p.isActive, p.companyId]),
        [["peter@chykalophia.com", "Peter", "admin", true, true, companies[0].id]],
      );
      assert.equal(people[0].emailVerified, false, "signing in proves the email; setup doesn't");
      assert.deepEqual(
        types.sort((a, b) => a.sortOrder - b.sortOrder).map((ty) => ty.code),
        ["PTO", "EMERGENCY", "SICK", "BONUS"],
        "PTO first: the request form's default and the year-end note's type",
      );
      assert.deepEqual(
        marker.map((m) => m.method),
        ["setup"],
      );
      assert.deepEqual(audit.map((a) => [a.action, a.actorId, a.actorVia]).sort(), [
        ["leave_type.created", people[0].id, "first_install"],
        ["leave_type.created", people[0].id, "first_install"],
        ["leave_type.created", people[0].id, "first_install"],
        ["leave_type.created", people[0].id, "first_install"],
        ["user.created", people[0].id, "first_install"],
      ]);

      // Closed: the page reads it so, and a second run changes nothing, whatever the token.
      assert.equal(await isSetupOpen(ctx, TOKEN), false);
      assert.equal(await installStatus(ctx, TOKEN), "installed");
      await assert.rejects(runFirstInstall(ctx, input({ adminEmail: "eve@evil.test" }), TOKEN), refusedWith("not_found"));
      const after = await counts(t);
      assert.deepEqual([after.companies.length, after.people.length], [1, 1]);
    });
  });

  test("two setups racing each other: exactly one wins", async () => {
    await withEmptyDatabase(async (t) => {
      const ctx = createTestContext(t.db);
      const results = await Promise.allSettled([
        runFirstInstall(ctx, input({ adminEmail: "one@chykalophia.com" }), TOKEN),
        runFirstInstall(ctx, input({ adminEmail: "two@chykalophia.com" }), TOKEN),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
      const lost = results.find((r) => r.status === "rejected");
      assert.ok(lost && isDomainError(lost.reason, "not_found"));
      const { companies, people } = await counts(t);
      assert.deepEqual([companies.length, people.length], [1, 1]);
    });
  });

  test("a database that already has a company (seeded before setup existed) is closed, token or not", async () => {
    await withEmptyDatabase(async (t) => {
      await seedCompany(t.db, { boss: { role: "admin" } });
      const ctx = createTestContext(t.db);
      assert.equal(await isSetupOpen(ctx, TOKEN), false);
      await assert.rejects(runFirstInstall(ctx, input(), TOKEN), refusedWith("not_found"));
      assert.equal((await counts(t)).companies.length, 1);
    });
  });

  test("bad input is refused and writes nothing", async () => {
    await withEmptyDatabase(async (t) => {
      const ctx = createTestContext(t.db);
      for (const bad of [
        input({ adminEmail: "not an email" }),
        input({ companyName: "  " }),
        input({ timezone: "Mars/Olympus" }),
        input({ adminName: "" }),
      ]) {
        await assert.rejects(runFirstInstall(ctx, bad, TOKEN), refusedWith("invalid_input"));
      }
      assert.equal((await counts(t)).companies.length, 0);
      assert.equal(await isSetupOpen(ctx, TOKEN), true, "still open after a refused attempt");
    });
  });
});
