import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultLeaveTypes, normalizeInstall } from "@/domain/install";
import { setupTokenMatches } from "@/lib/setup-token";

test("the setup token must match exactly, and nothing matches when none is configured", () => {
  const token = "x".repeat(40);
  assert.equal(setupTokenMatches(token, token), true);
  assert.equal(setupTokenMatches(`${token} `, token), false);
  assert.equal(setupTokenMatches(token.slice(1), token), false, "a different length is just a mismatch");
  assert.equal(setupTokenMatches("", undefined), false);
  assert.equal(setupTokenMatches("", ""), false, "an empty token never opens setup");
});

test("a new company starts with PTO first, every type spelled out", () => {
  const types = defaultLeaveTypes();
  assert.deepEqual(
    types.map((t) => [t.code, t.sortOrder]),
    [
      ["PTO", 0],
      ["EMERGENCY", 1],
      ["SICK", 2],
      ["BONUS", 3],
    ],
  );
  assert.ok(types.every((t) => t.carryoverEnabled === false && t.countsAgainstAllowance && t.isPaid));
});

test("setup input is trimmed and lowercased, and refused when it can't be used", () => {
  assert.deepEqual(
    normalizeInstall({ companyName: "  Chykalophia  ", timezone: " UTC ", adminName: " Peter  K ", adminEmail: " Peter@X.com " }),
    { companyName: "Chykalophia", timezone: "UTC", adminName: "Peter K", adminEmail: "peter@x.com" },
  );
  for (const bad of [
    { companyName: "", timezone: "UTC", adminName: "P", adminEmail: "p@x.com" },
    { companyName: "C", timezone: "Nowhere/Here", adminName: "P", adminEmail: "p@x.com" },
    { companyName: "C", timezone: "UTC", adminName: "P", adminEmail: "p@" },
  ]) {
    assert.throws(() => normalizeInstall(bad), /./);
  }
});
