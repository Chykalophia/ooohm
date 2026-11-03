import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { deleteSignInOf } from "@/server/repositories/person-deletion";
import { getAccount, hasPasskey } from "@/server/services/account";
import { seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

/** A passkey row as Better Auth's plugin writes it, with key material nobody should ever be shown. */
let added = 0;
const row = (userId: string, name: string | null, deviceType = "singleDevice") => ({
  id: randomUUID(),
  name,
  publicKey: `PUBLIC-KEY-${randomUUID()}`,
  userId,
  credentialID: `CREDENTIAL-${randomUUID()}`,
  counter: 0,
  deviceType,
  backedUp: deviceType === "multiDevice",
  transports: "internal",
  // Each a minute after the last, so "oldest first" has one answer.
  createdAt: new Date(Date.UTC(2026, 10, 2, 15, added++)),
});

describe("passkeys", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  test("the account page lists only the person's own passkeys, never their keys", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" }, bo: { managerKey: "boss" } });
    const ctx = createTestContext(t.db);
    await t.db
      .insert(schema.passkey)
      .values([row(co.people.ana.id, "Work laptop"), row(co.people.ana.id, null, "multiDevice"), row(co.people.bo.id, "Bo's phone")]);

    const account = await getAccount(ctx, co.people.ana);
    assert.deepEqual(
      account.passkeys.map((p) => [p.name, p.synced]),
      [
        ["Work laptop", false],
        [null, true],
      ],
    );
    const text = JSON.stringify(account);
    assert.doesNotMatch(text, /PUBLIC-KEY|CREDENTIAL-/, "key material never leaves the service");
    assert.equal(account.timezone, "America/Chicago");

    assert.equal(await hasPasskey(ctx, co.people.ana), true);
    assert.equal(await hasPasskey(ctx, co.people.boss), false);
  });

  test("deleting someone's sign-in data removes their passkeys, and nobody else's", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" }, bo: { managerKey: "boss" } });
    await t.db.insert(schema.passkey).values([row(co.people.ana.id, "A"), row(co.people.ana.id, "B"), row(co.people.bo.id, "C")]);

    const removed = await t.db.transaction((tx) => deleteSignInOf(tx, co.people.ana));
    assert.equal(removed.passkeys, 2);
    assert.equal((await t.db.select().from(schema.passkey).where(eq(schema.passkey.userId, co.people.ana.id))).length, 0);
    assert.equal((await t.db.select().from(schema.passkey).where(eq(schema.passkey.userId, co.people.bo.id))).length, 1);
  });
});
