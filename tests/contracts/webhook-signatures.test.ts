/**
 * The webhook request contract (docs/api.md#the-request, #verifying-the-signature): the
 * headers OOOhm sends, and signatures checked against vectors computed outside Node
 * (Python's hmac, in webhook-signatures.json) and against the receiver snippet the docs
 * publish, run as written.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { signWebhook, verifyWebhookSignature, webhookRequestHeaders } from "@/lib/integration-crypto";
import { contractProblems, webhookHeadersSchema } from "@/modules/integrations/application/contracts";

interface Vector {
  secret: string;
  timestamp: number;
  rawBody: string;
  signature: string;
}

type DocsVerifier = (input: { secret: string; rawBody: string; headers: Record<string, string> }) => boolean;

const vectors = JSON.parse(readFileSync(new URL("./webhook-signatures.json", import.meta.url), "utf8")) as Vector[];
const docs = readFileSync(new URL("../../docs/api.md", import.meta.url), "utf8");

/** The `js` block of docs/api.md that defines `verifyOoohmWebhook`. */
function docsSnippet(): string {
  const blocks = [...docs.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
  const snippet = blocks.find((b) => b.includes("export function verifyOoohmWebhook"));
  assert.ok(snippet, "docs/api.md has the verifyOoohmWebhook snippet");
  return snippet;
}

const lowerCase = (headers: Record<string, string>) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

let dir: string;
let verifyOoohmWebhook: DocsVerifier;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "ooohm-contract-"));
  const file = join(dir, "verify.mjs");
  writeFileSync(file, docsSnippet());
  ({ verifyOoohmWebhook } = (await import(pathToFileURL(file).href)) as { verifyOoohmWebhook: DocsVerifier });
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe("signature vectors", () => {
  for (const v of vectors) {
    test(`${v.secret} at ${v.timestamp}: signWebhook matches, verifyWebhookSignature accepts`, () => {
      assert.equal(signWebhook(v.secret, v.timestamp, v.rawBody), v.signature);
      const check = { secret: v.secret, rawBody: v.rawBody, timestampHeader: String(v.timestamp), nowSeconds: v.timestamp };
      assert.equal(verifyWebhookSignature({ ...check, signatureHeader: `v1=${v.signature}` }), true);
      assert.equal(verifyWebhookSignature({ ...check, signatureHeader: `v1=${"0".repeat(64)}, v1=${v.signature}` }), true);
      assert.equal(verifyWebhookSignature({ ...check, rawBody: `${v.rawBody} `, signatureHeader: `v1=${v.signature}` }), false);
    });
  }
});

describe("one delivery's request", () => {
  const sample = JSON.parse(readFileSync(new URL("./events.json", import.meta.url), "utf8"))[0];
  const body = JSON.stringify(sample);
  const secret = "whsec_contract-test";
  const request = (timestamp: number) =>
    lowerCase(webhookRequestHeaders({ secret, eventId: sample.id, eventType: sample.type, timestamp, body }));

  test("carries the documented headers and an envelope that matches the contract", () => {
    const parsed = webhookHeadersSchema.safeParse(request(1793588645));
    assert.equal(parsed.success, true, parsed.error?.message);
    assert.deepEqual(contractProblems(JSON.parse(body)), []);
  });

  test("the docs' receiver snippet accepts it as sent", () => {
    assert.equal(verifyOoohmWebhook({ secret, rawBody: body, headers: request(Math.floor(Date.now() / 1000)) }), true);
  });

  test("the docs' receiver snippet refuses a changed body, another secret, or a stale timestamp", () => {
    const now = Math.floor(Date.now() / 1000);
    assert.equal(verifyOoohmWebhook({ secret, rawBody: body.replace(`"days":3`, `"days":30`), headers: request(now) }), false);
    assert.equal(verifyOoohmWebhook({ secret: "whsec_other", rawBody: body, headers: request(now) }), false);
    assert.equal(verifyOoohmWebhook({ secret, rawBody: body, headers: request(now - 6 * 60) }), false);
  });
});
