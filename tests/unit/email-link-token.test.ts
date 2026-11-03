import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveLinkKey, signApproveToken, verifyApproveToken } from "@/lib/email-link-token";
import { formatTypicalWait } from "@/lib/format";

const key = deriveLinkKey("a".repeat(32));
const claims = { requestId: "11111111-1111-4111-8111-111111111111", approverId: "u-1", expiresAt: 2_000_000_000 };
const before = new Date(1_999_999_999_000);

test("a signed token verifies and returns its claims", () => {
  assert.deepEqual(verifyApproveToken(key, signApproveToken(key, claims), before), { ok: true, claims });
});

test("the link key depends on the secret and is not the secret", () => {
  assert.notEqual(deriveLinkKey("a".repeat(32)), deriveLinkKey("b".repeat(32)));
  assert.notEqual(key, "a".repeat(32));
});

test("expired, tampered, foreign and malformed tokens are refused", () => {
  const token = signApproveToken(key, claims);
  assert.deepEqual(verifyApproveToken(key, token, new Date(2_000_000_000_000)), { ok: false, reason: "expired" });

  const [body, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ r: claims.requestId, a: "u-2", e: claims.expiresAt })).toString("base64url");
  assert.deepEqual(verifyApproveToken(key, `${forged}.${sig}`, before), { ok: false, reason: "invalid" }, "claims swapped under an old signature");
  assert.deepEqual(verifyApproveToken(deriveLinkKey("b".repeat(32)), token, before), { ok: false, reason: "invalid" }, "another key");
  for (const bad of ["", "x", `${body}.`, `.${sig}`, `${token}.extra`, "x".repeat(600)]) {
    assert.deepEqual(verifyApproveToken(key, bad, before), { ok: false, reason: "invalid" }, bad.slice(0, 20));
  }
  // Correctly signed but not the claims shape.
  const odd = Buffer.from(JSON.stringify({ r: 1 })).toString("base64url");
  const signed = signApproveToken(key, claims).split(".")[1];
  assert.equal(verifyApproveToken(key, `${odd}.${signed}`, before).ok, false);
});

test("typical wait rounds up and reads naturally", () => {
  assert.equal(formatTypicalWait(0.2), "usually decides within an hour");
  assert.equal(formatTypicalWait(4.1), "usually decides within 5 hours");
  assert.equal(formatTypicalWait(23.5), "usually decides within 24 hours");
  assert.equal(formatTypicalWait(24), "usually decides within a day");
  assert.equal(formatTypicalWait(50), "usually decides within 3 days");
});
