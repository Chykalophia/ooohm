import assert from "node:assert/strict";
import { test } from "node:test";
import { createMailTransport, type MailConfig } from "@/lib/mail/registry";
import { createSendGridTransport, SENDGRID_ENDPOINTS } from "@/lib/mail/sendgrid";
import { MailSendError, parseMailbox } from "@/lib/mail/transport";

const KEY = "SG.secret-key-never-in-errors";
const MAIL = {
  from: "OOOhm <no-reply@ooohm.team>",
  to: "ana@chykalophia.com",
  subject: "Your OOOhm sign-in link",
  text: "Sign in: https://ooohm.team/api/auth/magic-link/verify?token=abc",
  html: '<a href="https://ooohm.team/api/auth/magic-link/verify?token=abc">Sign in</a>',
};

/** A fetch that records what it was asked and answers with `status` and `body`. */
function fakeFetch(status: number, body = "") {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body || null, { status });
  }) as typeof fetch;
  return { calls, impl };
}

test("SendGrid: one authenticated POST with both bodies, and tracking off so sign-in links stay intact", async () => {
  const f = fakeFetch(202);
  await createSendGridTransport({ apiKey: KEY, fetch: f.impl }).send(MAIL);

  assert.equal(f.calls.length, 1, "exactly one request per message");
  const [{ url, init }] = f.calls;
  assert.equal(url, SENDGRID_ENDPOINTS.global);
  assert.equal(init.method, "POST");
  assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
  const body = JSON.parse(String(init.body));
  assert.deepEqual(body.personalizations, [{ to: [{ email: "ana@chykalophia.com" }] }]);
  assert.deepEqual(body.from, { email: "no-reply@ooohm.team", name: "OOOhm" });
  assert.equal(body.subject, MAIL.subject);
  assert.deepEqual(
    body.content.map((c: { type: string }) => c.type),
    ["text/plain", "text/html"],
    "plain text first, as SendGrid requires",
  );
  assert.equal(body.tracking_settings.click_tracking.enable, false);
  assert.equal(body.tracking_settings.click_tracking.enable_text, false);
  assert.equal(body.tracking_settings.open_tracking.enable, false);
  assert.ok(body.content[1].value.includes("token=abc"), "the link goes out exactly as written");
});

test("SendGrid: an EU account sends through the EU host; a text-only message has one body", async () => {
  const f = fakeFetch(202);
  await createSendGridTransport({ apiKey: KEY, region: "eu", fetch: f.impl }).send({ ...MAIL, html: undefined });
  assert.equal(f.calls[0].url, SENDGRID_ENDPOINTS.eu);
  assert.equal(JSON.parse(String(f.calls[0].init.body)).content.length, 1);
});

test("SendGrid: a refusal or a network failure throws, naming the status but never the key", async () => {
  const refused = fakeFetch(401, '{"errors":[{"message":"The provided authorization grant is invalid"}]}');
  await assert.rejects(createSendGridTransport({ apiKey: KEY, fetch: refused.impl }).send(MAIL), (err) => {
    assert.ok(err instanceof MailSendError);
    assert.equal(err.status, 401);
    assert.match(err.message, /^sendgrid: HTTP 401: .*authorization grant is invalid/);
    assert.doesNotMatch(err.message, /secret-key/);
    return true;
  });

  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await assert.rejects(createSendGridTransport({ apiKey: KEY, fetch: down }).send(MAIL), (err) => {
    assert.ok(err instanceof MailSendError);
    assert.equal(err.status, undefined);
    assert.doesNotMatch(err.message, /secret-key/);
    return true;
  });
});

test("mailboxes: a display name splits from its address; a bare address stays as it is", () => {
  assert.deepEqual(parseMailbox("OOOhm <no-reply@ooohm.team>"), { email: "no-reply@ooohm.team", name: "OOOhm" });
  assert.deepEqual(parseMailbox('"Chykalophia, OOOhm" <hi@x.co>'), { email: "hi@x.co", name: "Chykalophia, OOOhm" });
  assert.deepEqual(parseMailbox(" no-reply@ooohm.team "), { email: "no-reply@ooohm.team" });
  assert.deepEqual(parseMailbox("<no-reply@ooohm.team>"), { email: "no-reply@ooohm.team" });
});

test("the registry builds the transport MAIL_TRANSPORT names, and refuses SendGrid without a key", () => {
  const config: MailConfig = {
    transport: "smtp",
    smtp: { host: "localhost", port: 1025, secure: false, requireTls: false },
    sendgrid: { region: "global" },
  };
  assert.equal(createMailTransport(config).name, "smtp");
  assert.throws(() => createMailTransport({ ...config, transport: "sendgrid" }), /SENDGRID_API_KEY/);
  assert.equal(createMailTransport({ ...config, transport: "sendgrid", sendgrid: { apiKey: KEY, region: "eu" } }).name, "sendgrid");
});
