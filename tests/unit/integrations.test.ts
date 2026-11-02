import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isDomainError } from "@/domain/errors";
import {
  ADMIN_EVENT_TYPES,
  BALANCE_EVENT_TYPES,
  CALENDAR_FEED_EVENT_TYPES,
  INTEGRATION_EVENT_TYPES,
  LEAVE_EVENT_TYPES,
  LEAVE_REASSIGNED_EVENT_TYPE,
} from "@/domain/events";
import {
  assertScope,
  buildEnvelope,
  MAX_DELIVERY_ATTEMPTS,
  normalizeApiKeyName,
  normalizeEventTypes,
  normalizeWebhookDescription,
  RETRY_DELAYS_MS,
  retryDelayMs,
  WEBHOOK_EVENT_GROUPS,
  WEBHOOK_EVENT_TYPES,
} from "@/domain/integrations";
import { embeddedIpv4, isBlockedAddress, normalizeWebhookUrl, parseIpv6, STRICT_TARGET_POLICY, urlOrigin } from "@/domain/webhook-target";
import {
  apiKeyFromAuthorization,
  createSecretBox,
  generateApiKey,
  generateWebhookSecret,
  hashApiKey,
  parseEncryptionKey,
  sameDigest,
  signWebhook,
  verifyWebhookSignature,
  webhookRequestHeaders,
} from "@/lib/integration-crypto";
import { loadWorkerEnv } from "@/lib/worker-env";
import { adapterRegistry, createAdapterRegistry, type Adapter } from "@/server/integrations/adapter";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (isDomainError(err)) return err.code;
    throw err;
  }
  return "ok";
};

describe("webhook signatures", () => {
  test("HMAC-SHA256 over `${timestamp}.${body}` matches an independently computed vector (openssl dgst -hmac)", () => {
    const body = '{"id":"evt_1","type":"ping"}';
    assert.equal(signWebhook("whsec_test-secret", 1700000000, body), "45abb3712e703a38ae8d46282ef5e6c9363b7a4cf4fe6b724c19d08a666739d3");
  });

  test("a delivery carries the four OOOhm headers, the signature as v1=<64 hex>", () => {
    const headers = webhookRequestHeaders({ secret: "whsec_x", eventId: "e-1", eventType: "leave.approved", timestamp: 1700000123, body: "{}" });
    assert.equal(headers["OOOhm-Event-Id"], "e-1");
    assert.equal(headers["OOOhm-Event-Type"], "leave.approved");
    assert.equal(headers["OOOhm-Timestamp"], "1700000123");
    assert.match(headers["OOOhm-Signature"], /^v1=[0-9a-f]{64}$/);
    assert.equal(headers["OOOhm-Signature"], `v1=${signWebhook("whsec_x", 1700000123, "{}")}`);
    assert.equal(headers["Content-Type"], "application/json");
  });

  test("verification accepts the right signature and refuses a changed body, secret or timestamp, or a stale one", () => {
    const secret = generateWebhookSecret();
    const rawBody = '{"id":"a","data":{"days":1}}';
    const ts = 1700000000;
    const header = `v1=${signWebhook(secret, ts, rawBody)}`;
    const ok = (over: Partial<Parameters<typeof verifyWebhookSignature>[0]>) =>
      verifyWebhookSignature({ secret, rawBody, timestampHeader: String(ts), signatureHeader: header, nowSeconds: ts + 10, ...over });
    assert.equal(ok({}), true);
    assert.equal(ok({ rawBody: rawBody.replace("1", "2") }), false, "tampered body");
    assert.equal(ok({ secret: generateWebhookSecret() }), false, "other secret");
    assert.equal(ok({ timestampHeader: String(ts + 1) }), false, "timestamp is signed");
    assert.equal(ok({ nowSeconds: ts + 301 }), false, "older than 5 minutes");
    assert.equal(ok({ nowSeconds: ts + 300 }), true, "exactly 5 minutes is accepted");
    assert.equal(ok({ signatureHeader: `v1=${"0".repeat(64)}, ${header}` }), true, "any v1 value may match");
    assert.equal(ok({ signatureHeader: "v1=zz" }), false);
    assert.equal(ok({ timestampHeader: null }), false);
  });

  test("secrets are whsec_ plus 32 random bytes", () => {
    const a = generateWebhookSecret();
    assert.match(a, /^whsec_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, generateWebhookSecret());
  });
});

describe("secrets at rest (AES-256-GCM)", () => {
  const key = Buffer.alloc(32, 1).toString("base64");

  test("round trip, with a fresh IV each time", () => {
    const box = createSecretBox(key);
    const sealed = box.seal("whsec_abc", "endpoint-1");
    assert.match(sealed, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.ok(!sealed.includes("whsec_abc"));
    assert.notEqual(box.seal("whsec_abc", "endpoint-1"), sealed);
    assert.equal(box.open(sealed, "endpoint-1"), "whsec_abc");
  });

  test("tampering, another endpoint's context or another key is detected", () => {
    const box = createSecretBox(key);
    const sealed = box.seal("whsec_abc", "endpoint-1");
    const [v, iv, body, tag] = sealed.split(".");
    const flipped = Buffer.from(body, "base64url");
    flipped[0] ^= 1;
    assert.throws(() => box.open([v, iv, flipped.toString("base64url"), tag].join("."), "endpoint-1"));
    assert.throws(() => box.open(sealed, "endpoint-2"), "bound to its endpoint");
    assert.throws(() => createSecretBox(Buffer.alloc(32, 2).toString("base64")).open(sealed, "endpoint-1"));
    assert.throws(() => box.open("v1.only", "endpoint-1"));
  });

  test("the key must be exactly 32 bytes of base64", () => {
    assert.ok(parseEncryptionKey(key));
    assert.equal(parseEncryptionKey(Buffer.alloc(31).toString("base64")), null);
    assert.equal(parseEncryptionKey("not base64 !"), null);
    assert.throws(() => createSecretBox("short"));
  });
});

describe("retry schedule", () => {
  test("1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h, then failed after the 8th attempt", () => {
    const mid = [1, 2, 3, 4, 5, 6, 7].map((n) => retryDelayMs(n, 0.5));
    assert.deepEqual(mid, [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000, 86_400_000]);
    assert.equal(MAX_DELIVERY_ATTEMPTS, 8);
    assert.equal(retryDelayMs(8, 0.5), null);
    assert.equal(retryDelayMs(9, 0.5), null);
    const total = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    assert.equal(total, (44 * 60 + 36) * 60_000, "44 h 36 min from the first failure to the last attempt");
  });

  test("jitter moves each wait by at most 10% either way", () => {
    assert.equal(retryDelayMs(1, 0), 54_000);
    assert.equal(retryDelayMs(1, 0.999999), 66_000);
    assert.throws(() => retryDelayMs(0, 0.5));
  });
});

describe("addresses a webhook may not reach", () => {
  const blocked = [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "2001:db8::1",
    "[::1]",
    "not-an-ip",
    "1.2.3",
    "fe80::1%eth0",
  ];
  const allowed = ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2002:808:808::1"];

  for (const ip of blocked) test(`blocks ${ip}`, () => assert.equal(isBlockedAddress(ip), true));
  for (const ip of allowed) test(`allows ${ip}`, () => assert.equal(isBlockedAddress(ip), false));

  test("IPv6 parsing handles compression and an embedded IPv4 tail", () => {
    assert.deepEqual(parseIpv6("::1"), [...Array(15).fill(0), 1]);
    assert.deepEqual(parseIpv6("::ffff:1.2.3.4")?.slice(10), [0xff, 0xff, 1, 2, 3, 4]);
    assert.deepEqual(parseIpv6("1:2:3:4:5:6:7:8")?.slice(0, 2), [0, 1]);
    assert.equal(parseIpv6("1::2::3"), null);
    assert.equal(parseIpv6("1:2:3:4:5:6:7:8:9"), null);
    assert.deepEqual(embeddedIpv4(parseIpv6("::ffff:10.0.0.1")!), [10, 0, 0, 1]);
  });
});

describe("webhook URLs", () => {
  const dev = { allowInsecure: true, allowPrivate: true };
  const strict = (url: string) => code(() => normalizeWebhookUrl(url, STRICT_TARGET_POLICY));

  test("public https URLs pass and come back normalized", () => {
    assert.equal(normalizeWebhookUrl("  https://Example.com/hooks?x=1 ", STRICT_TARGET_POLICY), "https://example.com/hooks?x=1");
  });

  test("http is refused unless allowed for development", () => {
    assert.equal(strict("http://example.com/h"), "insecure_url");
    assert.equal(strict("ftp://example.com/h"), "insecure_url");
    assert.equal(normalizeWebhookUrl("http://example.com/h", { allowInsecure: true, allowPrivate: false }), "http://example.com/h");
  });

  test("private, loopback and local hosts are refused unless allowed, in every spelling", () => {
    for (const url of [
      "https://127.0.0.1/h",
      "https://localhost:8443/h",
      "https://api.localhost/h",
      "https://printer.local/h",
      "https://[::1]/h",
      "https://[::ffff:127.0.0.1]/h",
      "https://169.254.169.254/latest/meta-data",
      "https://2130706433/h",
      "https://0x7f.1/h",
      "https://intranet/h",
    ]) {
      assert.equal(strict(url), "blocked_address", url);
    }
    assert.equal(normalizeWebhookUrl("http://localhost:4000/h", dev), "http://localhost:4000/h");
  });

  test("credentials, fragments, junk and over-long URLs are refused", () => {
    assert.equal(strict("https://user:pw@example.com/h"), "invalid_input");
    assert.equal(strict("https://example.com/h#frag"), "invalid_input");
    assert.equal(strict("not a url"), "invalid_input");
    assert.equal(strict(""), "invalid_input");
    assert.equal(strict(`https://example.com/${"a".repeat(2100)}`), "invalid_input");
  });

  test("events and audit rows carry only the origin", () => {
    assert.equal(urlOrigin("https://hooks.zapier.com/hooks/catch/123/secret-path/"), "https://hooks.zapier.com");
  });
});

describe("event catalogue and envelope", () => {
  test("every outbox event type is subscribable, exactly once; ping is not", () => {
    const all = [
      ...Object.values(LEAVE_EVENT_TYPES),
      LEAVE_REASSIGNED_EVENT_TYPE,
      ...Object.values(BALANCE_EVENT_TYPES),
      ...Object.values(ADMIN_EVENT_TYPES),
      ...Object.values(CALENDAR_FEED_EVENT_TYPES),
      ...Object.values(INTEGRATION_EVENT_TYPES),
    ];
    assert.deepEqual([...WEBHOOK_EVENT_TYPES].sort(), [...all].sort());
    assert.equal(new Set(WEBHOOK_EVENT_TYPES).size, WEBHOOK_EVENT_TYPES.length);
    assert.ok(!WEBHOOK_EVENT_TYPES.includes("ping"));
    assert.deepEqual(
      WEBHOOK_EVENT_GROUPS.filter((g) => g.common).map((g) => g.label),
      ["Leave", "Balances", "People"],
    );
  });

  test("the public event names never change", () => {
    assert.deepEqual(Object.values(LEAVE_EVENT_TYPES), ["leave.requested", "leave.approved", "leave.rejected", "leave.cancelled"]);
    assert.equal(BALANCE_EVENT_TYPES.adjusted, "balance.adjusted");
    assert.equal(ADMIN_EVENT_TYPES.userCreated, "user.created");
  });

  test("subscriptions are deduplicated into catalogue order; none or an unknown type is refused", () => {
    assert.deepEqual(normalizeEventTypes(["balance.adjusted", "leave.requested", "balance.adjusted"]), ["leave.requested", "balance.adjusted"]);
    assert.equal(code(() => normalizeEventTypes([])), "invalid_input");
    assert.equal(code(() => normalizeEventTypes(["leave.exploded"])), "invalid_input");
    assert.equal(code(() => normalizeEventTypes(["ping"])), "invalid_input");
  });

  test("the envelope is { id, type, version: 1, createdAt (ISO UTC), companyId, data }", () => {
    const envelope = buildEnvelope({ id: "e1", type: "leave.approved", companyId: "c1", createdAt: new Date("2026-11-01T15:00:00.123Z"), payload: { days: 1 } });
    assert.deepEqual(envelope, { id: "e1", type: "leave.approved", version: 1, createdAt: "2026-11-01T15:00:00.123Z", companyId: "c1", data: { days: 1 } });
    assert.deepEqual(Object.keys(envelope), ["id", "type", "version", "createdAt", "companyId", "data"]);
  });

  test("names and descriptions are one line and bounded", () => {
    assert.equal(normalizeApiKeyName("  Payroll\n export "), "Payroll export");
    assert.equal(code(() => normalizeApiKeyName("  ")), "invalid_input");
    assert.equal(code(() => normalizeApiKeyName("x".repeat(61))), "invalid_input");
    assert.equal(normalizeWebhookDescription(""), "");
    assert.equal(code(() => normalizeWebhookDescription("x".repeat(201))), "invalid_input");
  });
});

describe("API keys", () => {
  test("a key is ooohm_ plus 43 characters; only its SHA-256 and an 8-character prefix are kept", () => {
    const { key, hash, prefix } = generateApiKey();
    assert.match(key, /^ooohm_[A-Za-z0-9_-]{43}$/);
    assert.equal(hash, hashApiKey(key));
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(prefix, key.slice(0, 14));
    assert.ok(sameDigest(hash, hashApiKey(key)));
    assert.ok(!sameDigest(hash, generateApiKey().hash));
    assert.ok(!sameDigest("", ""));
  });

  test("only a well-formed Bearer header yields a key", () => {
    const { key } = generateApiKey();
    assert.equal(apiKeyFromAuthorization(`Bearer ${key}`), key);
    assert.equal(apiKeyFromAuthorization(`bearer ${key}`), key);
    assert.equal(apiKeyFromAuthorization(key), null);
    assert.equal(apiKeyFromAuthorization(`Basic ${key}`), null);
    assert.equal(apiKeyFromAuthorization(`Bearer ${key}x`), null);
    assert.equal(apiKeyFromAuthorization("Bearer ooohm_short"), null);
    assert.equal(apiKeyFromAuthorization(null), null);
  });

  test("scopes: read passes, write is refused for a read key", () => {
    assert.doesNotThrow(() => assertScope({ scopes: ["read"] }, "read"));
    assert.equal(code(() => assertScope({ scopes: ["read"] }, "write")), "forbidden");
  });
});

describe("adapter registry", () => {
  const fake = (id: string): Adapter => ({
    id,
    displayName: id,
    handles: () => true,
    deliver: async () => {},
    healthCheck: async () => ({ ok: true }),
  });

  test("v1 ships no adapters", () => {
    assert.deepEqual(adapterRegistry.list(), []);
  });

  test("registers by unique, well-formed id", () => {
    const registry = createAdapterRegistry([fake("gusto")]);
    assert.equal(registry.get("gusto")?.displayName, "gusto");
    assert.throws(() => registry.register(fake("gusto")), /already registered/);
    assert.throws(() => registry.register(fake("Not Valid")));
    registry.register(fake("slack"));
    assert.deepEqual(
      registry.list().map((a) => a.id),
      ["gusto", "slack"],
    );
  });
});

describe("worker environment", () => {
  const key = Buffer.alloc(32, 3).toString("base64");

  test("needs only the database and the encryption key; never the auth secret", () => {
    const env = loadWorkerEnv({ DATABASE_URL: "postgres://u:p@db:5432/x", WEBHOOK_ENCRYPTION_KEY: key });
    assert.equal(env.WEBHOOK_ALLOW_INSECURE, false);
    assert.equal(env.WEBHOOK_ALLOW_PRIVATE, false);
    assert.equal(env.WORKER_POLL_INTERVAL_MS, 1000);
    assert.equal(env.LOG_LEVEL, "info");
    assert.ok(!("BETTER_AUTH_SECRET" in env));
  });

  test("refuses a missing or malformed key", () => {
    assert.throws(() => loadWorkerEnv({ DATABASE_URL: "postgres://u:p@db:5432/x" }), /WEBHOOK_ENCRYPTION_KEY/);
    assert.throws(() => loadWorkerEnv({ DATABASE_URL: "postgres://u:p@db:5432/x", WEBHOOK_ENCRYPTION_KEY: "abc" }), /32 bytes/);
  });
});
