import assert from "node:assert/strict";
import { test } from "node:test";
import { passkeyRelyingParty } from "@/lib/passkey-rp";

test("passkeys bind to the app's host by default, with its origin", () => {
  assert.deepEqual(passkeyRelyingParty("https://hr.example.com"), { rpID: "hr.example.com", origin: "https://hr.example.com" });
  assert.deepEqual(passkeyRelyingParty("http://localhost:3000/"), { rpID: "localhost", origin: "http://localhost:3000" });
});

test("a parent domain is allowed, so passkeys survive a move between its subdomains", () => {
  assert.equal(passkeyRelyingParty("https://hrtemp.example.com", "example.com").rpID, "example.com");
  assert.equal(passkeyRelyingParty("https://hr.example.com", " Example.COM. ").rpID, "example.com");
  assert.equal(passkeyRelyingParty("https://hr.example.com", "hr.example.com").rpID, "hr.example.com");
});

test("a domain the browser would refuse fails at start", () => {
  for (const bad of ["other.com", "ample.com", "sub.hr.example.com"]) {
    assert.throws(() => passkeyRelyingParty("https://hr.example.com", bad), /PASSKEY_RP_ID/, bad);
  }
});
