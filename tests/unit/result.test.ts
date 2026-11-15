import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainError, isDomainError } from "@/domain/errors";
import { attempt, err, fromDomainError, isErr, isOk, isServiceResult, map, ok, unwrap, valueOf } from "@/shared/lib/result";

test("ok and err build the two halves of a result", () => {
  const good = ok(3);
  assert.equal(good.ok, true);
  assert.equal(isOk(good) && good.value, 3);
  const bad = err("not_found");
  assert.ok(isErr(bad));
  assert.deepEqual(bad.error, { code: "not_found", message: "not_found" });
  assert.deepEqual(err("invalid_input", "Too long.", { field: "name" }).error, { code: "invalid_input", message: "Too long.", details: { field: "name" } });
});

test("only results made by ok and err count as results", () => {
  assert.ok(isServiceResult(ok(1)));
  assert.ok(isServiceResult(err("conflict")));
  assert.ok(!isServiceResult({ ok: true, value: 1 }), "a plain object with an ok field is a value");
  assert.ok(!isServiceResult(null));
  assert.ok(!isServiceResult("ok"));
});

test("map changes a success and passes a failure through", () => {
  assert.equal(unwrap(map(ok(2), (n) => n * 2)), 4);
  const failed = err("forbidden");
  assert.equal(map(failed, () => 1), failed);
});

test("fromDomainError converts a DomainError and rethrows anything else", () => {
  const converted = fromDomainError(new DomainError("insufficient_balance", "short", { year: 2026, requested: 2, remaining: 0, yearsSpanned: 1 }));
  assert.deepEqual(converted.error, { code: "insufficient_balance", message: "short", details: { year: 2026, requested: 2, remaining: 0, yearsSpanned: 1 } });
  const fault = new Error("database down");
  assert.throws(() => fromDomainError(fault), (e) => e === fault);
});

test("attempt turns a thrown DomainError into a failure after the work settles", async () => {
  assert.equal(unwrap(await attempt(async () => "done")), "done");
  const refused = await attempt(async () => {
    throw new DomainError("past_year_closed");
  });
  assert.ok(isErr(refused) && refused.error.code === "past_year_closed");
  await assert.rejects(attempt(async () => {
    throw new TypeError("bug");
  }), TypeError);
});

test("unwrap throws a failure as the DomainError it stands for", () => {
  assert.throws(() => unwrap(err("not_found", "Gone.")), (e) => isDomainError(e, "not_found") && e.message === "Gone.");
});

test("valueOf passes plain values through and unwraps results", () => {
  assert.equal(valueOf("plain"), "plain");
  assert.equal(valueOf(ok("wrapped")), "wrapped");
  assert.throws(() => valueOf(err("conflict")), (e) => isDomainError(e, "conflict"));
});
