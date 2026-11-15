import assert from "node:assert/strict";
import { test } from "node:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { switchTenantWithin } from "@/db/tenant";
import type { Transaction } from "@/db/types";

/**
 * `switchTenantWithin` (src/db/tenant.ts): the one switch of company inside a transaction
 * always switches back, whether the work succeeds or throws.
 */

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const dialect = new PgDialect();

/** A transaction that records the settings each statement sets, and can fail on the nth. */
function recordingTx(failOn?: number) {
  const settings: unknown[][] = [];
  const tx = {
    execute: async (query: SQL) => {
      settings.push(dialect.sqlToQuery(query).params);
      if (settings.length === failOn) throw new Error("the transaction is aborted");
      return [];
    },
  } as unknown as Transaction;
  return { tx, settings };
}

test("the work runs in the target company, naming the company it came from, and the transaction switches back", async () => {
  const { tx, settings } = recordingTx();
  const seen: number[] = [];
  const result = await switchTenantWithin(tx, A, B, async () => {
    seen.push(settings.length);
    return "done";
  });
  assert.equal(result, "done");
  assert.deepEqual(seen, [1]);
  assert.deepEqual(settings, [
    ["app.company_id", B, "app.acting_company_id", A],
    ["app.company_id", A, "app.acting_company_id", ""],
  ]);
});

test("a failing work still switches back, and its own error is the one thrown", async () => {
  const { tx, settings } = recordingTx();
  await assert.rejects(
    switchTenantWithin(tx, A, B, async () => {
      throw new Error("work failed");
    }),
    /work failed/,
  );
  assert.equal(settings.length, 2, "switched back");
  assert.deepEqual(settings[1], ["app.company_id", A, "app.acting_company_id", ""]);
});

test("when switching back fails after the work failed, the work's error is the one thrown", async () => {
  const { tx } = recordingTx(2);
  await assert.rejects(
    switchTenantWithin(tx, A, B, async () => {
      throw new Error("work failed");
    }),
    /work failed/,
  );
});

test("when switching back fails after the work succeeded, that failure is thrown", async () => {
  const { tx } = recordingTx(2);
  await assert.rejects(
    switchTenantWithin(tx, A, B, async () => "done"),
    /aborted/,
  );
});

test("the same company needs no switch, and a non-company id is refused", async () => {
  const { tx, settings } = recordingTx();
  assert.equal(await switchTenantWithin(tx, A, A, async () => 1), 1);
  assert.equal(settings.length, 0);
  await assert.rejects(switchTenantWithin(tx, A, "c1", async () => 1), /company id/);
});
