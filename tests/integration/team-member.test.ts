import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { isDomainError } from "@/domain/errors";
import { updateCompanySettings } from "@/server/services/admin-company";
import { getTeamMember } from "@/server/services/team-member";
import { seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

// The test clock is 2026-11-01 15:00 UTC: Nov 1 in Chicago.

/** Text only Ana's private details carry, to prove where it does and doesn't reach. */
const NOTE = "Dentist, private";
const REASON = "Enjoy the break";

describe("team member page", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  async function seeded() {
    const co = await seedCompany(t.db, {
      boss: { role: "admin" },
      mo: { role: "manager" },
      ana: { managerKey: "mo" },
      bo: { managerKey: "mo" },
      gone: { isActive: false },
    });
    const ctx = createTestContext(t.db);
    const { ana } = co.people;
    await t.db.insert(schema.leaveRequests).values([
      // Coming up, approved, with both notes.
      {
        companyId: co.companyId,
        userId: ana.id,
        leaveTypeId: co.pto,
        startDate: "2026-11-09",
        endDate: "2026-11-10",
        dayPortion: "full",
        days: 2,
        status: "approved",
        note: NOTE,
        decisionNote: REASON,
      },
      // Recent: ended last month.
      {
        companyId: co.companyId,
        userId: ana.id,
        leaveTypeId: co.pto,
        startDate: "2026-10-12",
        endDate: "2026-10-12",
        dayPortion: "full",
        days: 1,
        status: "approved",
      },
      // Declined leave never shows, to anyone.
      {
        companyId: co.companyId,
        userId: ana.id,
        leaveTypeId: co.pto,
        startDate: "2026-11-16",
        endDate: "2026-11-16",
        dayPortion: "full",
        days: 1,
        status: "rejected",
      },
    ]);
    return { co, ctx };
  }

  const leaked = (value: unknown) => {
    const text = JSON.stringify(value);
    return text.includes(NOTE) || text.includes(REASON);
  };

  test("a teammate sees who is off and when, never the notes, days or balances", async () => {
    const { co, ctx } = await seeded();
    const page = await getTeamMember(ctx, co.people.bo, co.people.ana.id);
    assert.equal(page.showDetails, false);
    assert.deepEqual(
      page.upcoming.map((e) => [e.startDate, e.status, e.details]),
      [["2026-11-09", "approved", null]],
      "the declined request is left out",
    );
    assert.deepEqual(
      page.recent.map((e) => e.startDate),
      ["2026-10-12"],
    );
    assert.equal(page.balances, null);
    assert.equal(leaked(page), false, "the note and the approver's reason never leave the service");
    assert.equal(page.person.managerName, "Mo");
  });

  test("the person's manager sees the details, until an admin turns that off", async () => {
    const { co, ctx } = await seeded();
    const before = await getTeamMember(ctx, co.people.mo, co.people.ana.id);
    assert.equal(before.showDetails, true);
    assert.deepEqual(before.upcoming[0]?.details, { days: 2, note: NOTE, decisionNote: REASON });
    assert.ok(before.balances && before.balances.items.length > 0, "and the balances");

    const [company] = await t.db.select().from(schema.companies).where(eq(schema.companies.id, co.companyId));
    await updateCompanySettings(ctx, co.people.boss, { ...company, managersSeeDetails: false });

    const after = await getTeamMember(ctx, co.people.mo, co.people.ana.id);
    assert.equal(after.showDetails, false);
    assert.equal(after.balances, null);
    assert.equal(leaked(after), false, "the manager is now a teammate like any other");
    assert.equal(after.upcoming.length, 1, "who is off and when still shows");

    // The person and admins keep seeing everything.
    for (const who of [co.people.ana, co.people.boss]) {
      const page = await getTeamMember(ctx, who, co.people.ana.id);
      assert.equal(page.showDetails, true, who.name);
      assert.equal(page.upcoming[0]?.details?.note, NOTE, who.name);
    }
    // A manager of someone else never did.
    assert.equal((await getTeamMember(ctx, co.people.mo, co.people.boss.id)).showDetails, false);
  });

  test("inactive people, other companies and malformed ids are not found", async () => {
    const { co, ctx } = await seeded();
    const other = await seedCompany(t.db, { eve: { role: "admin" } });
    for (const id of [co.people.gone.id, other.people.eve.id, randomUUID(), "not-a-uuid"]) {
      await assert.rejects(getTeamMember(ctx, co.people.boss, id), (err) => isDomainError(err, "not_found"), id);
    }
  });
});
