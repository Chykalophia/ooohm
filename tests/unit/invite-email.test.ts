import assert from "node:assert/strict";
import { test } from "node:test";
import { INVITE_SUBJECT, renderInviteEmail } from "@/server/notifications/templates/invite";

const base = {
  recipientName: "Ana",
  inviterName: "Peter",
  companyName: "Acme",
  link: "https://ooohm.team/api/auth/magic-link/verify?token=abc&callbackURL=%2F",
  signInUrl: "https://ooohm.team/sign-in",
};

test("the invite names who added the person, carries the link, and says how to get a new one", () => {
  const email = renderInviteEmail(base);
  assert.equal(email.subject, INVITE_SUBJECT);
  assert.match(email.text, /^Hi Ana,\n\nPeter added you to Acme on OOOhm/);
  assert.ok(email.text.includes(`Sign in: ${base.link}`));
  assert.ok(email.text.includes("expires in 15 minutes"));
  assert.ok(email.text.includes(base.signInUrl));
  assert.ok(email.html.includes('href="https://ooohm.team/api/auth/magic-link/verify?token=abc&amp;callbackURL=%2F"'));
});

test("typed names stay in the body, escaped, on one line; the subject never changes", () => {
  const email = renderInviteEmail({ ...base, inviterName: "<b>Boss</b>\nBcc: x@y.z", companyName: "A & B", recipientName: "" });
  assert.equal(email.subject, INVITE_SUBJECT);
  assert.ok(email.html.includes("&lt;b&gt;Boss&lt;/b&gt; Bcc: x@y.z added you to A &amp; B"));
  assert.ok(!email.html.includes("<b>"));
  assert.match(email.text, /^Hi,\n/);
  assert.ok(!email.text.includes("\nBcc:"), "a newline in a name cannot start a new line");
});
