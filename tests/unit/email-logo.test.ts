import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_EMAIL_ACCENT, emailAccent, emailDocument } from "@/lib/email-layout";
import { renderSignInEmail } from "@/lib/sign-in-email";

const SHA = "b".repeat(64);
const company = {
  name: `Acme & "Sons"`,
  theme: "classic",
  accentColor: null,
  logoSha256: SHA,
  logoType: "image/png",
  logoWidth: 400,
  logoHeight: 100,
};

test("email logo: a company with a logo gets it at the top of every email, fitted and named", () => {
  const accent = emailAccent(company, "https://hr.example.com");
  assert.deepEqual(accent.logo, { src: `https://hr.example.com/logo/${SHA}.png`, alt: `Acme & "Sons"`, width: 160, height: 40 });
  const html = renderSignInEmail("https://hr.example.com/x", accent).html;
  assert.ok(html.includes(`<img src="https://hr.example.com/logo/${SHA}.png" alt="Acme &amp; &quot;Sons&quot;" width="160" height="40"`));
  assert.doesNotMatch(html, />OOOhm<\/td>/, "the logo takes the wordmark's place");
});

test("email logo: without a logo, or without a public URL to point at, the wordmark stays", () => {
  assert.equal(emailAccent({ ...company, logoSha256: null }, "https://hr.example.com").logo, undefined);
  assert.equal(emailAccent(company).logo, undefined, "an image needs an absolute URL");
  assert.equal(DEFAULT_EMAIL_ACCENT.logo, undefined);
  assert.match(emailDocument("<p>x</p>", DEFAULT_EMAIL_ACCENT, undefined, "Hi"), />OOOhm<\/td>/);
});

test("email logo: a JPEG logo is linked as .jpg", () => {
  const accent = emailAccent({ ...company, logoType: "image/jpeg" }, "https://hr.example.com");
  assert.equal(accent.logo?.src, `https://hr.example.com/logo/${SHA}.jpg`);
  assert.ok(renderSignInEmail("https://hr.example.com/x", accent).html.includes(`<img src="https://hr.example.com/logo/${SHA}.jpg"`));
});

test("email logo: the app URL's trailing slash does not double up", () => {
  assert.equal(emailAccent(company, "https://hr.example.com/").logo?.src, `https://hr.example.com/logo/${SHA}.png`);
});
