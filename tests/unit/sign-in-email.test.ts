import assert from "node:assert/strict";
import { test } from "node:test";
import { emailAccent } from "@/lib/email-layout";
import { renderSignInEmail, SIGN_IN_SUBJECT } from "@/lib/sign-in-email";

const url = "https://ooohm.team/api/auth/magic-link/verify?token=abc&callbackURL=%2F";

test("the sign-in email carries the link in both parts, escaped in HTML", () => {
  const email = renderSignInEmail(url);
  assert.equal(email.subject, SIGN_IN_SUBJECT);
  assert.ok(email.text.includes(url));
  assert.ok(email.text.includes("expires in 15 minutes"));
  assert.ok(email.html.includes('href="https://ooohm.team/api/auth/magic-link/verify?token=abc&amp;callbackURL=%2F"'));
  assert.match(email.html, /bgcolor="#115e59"/, "classic teal by default");
});

test("the sign-in button takes the company's accent", () => {
  const email = renderSignInEmail(url, emailAccent({ theme: "plum", accentColor: null }));
  assert.match(email.html, /bgcolor="#6b2d5c"[^>]*><a href="https:\/\/ooohm\.team[^"]*"[^>]*>Sign in<\/a>/);
});
