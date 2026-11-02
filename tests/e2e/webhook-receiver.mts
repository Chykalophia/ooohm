/**
 * A tiny webhook receiver for trying OOOhm's webhooks locally, and for the end-to-end
 * demo. It verifies every request exactly as docs/api.md tells receivers to, using only
 * `node:crypto` (nothing from OOOhm), and prints one JSON line per request.
 *
 *   tsx tests/e2e/webhook-receiver.mts <port> <secret-file> [ok|fail]
 *
 * `fail` answers 500 to everything, to watch the worker retry. The secret is read from
 * `<secret-file>` on each request, so the receiver can start before the endpoint exists.
 * Point the endpoint at http://127.0.0.1:<port>/hook, with WEBHOOK_ALLOW_INSECURE=true
 * and WEBHOOK_ALLOW_PRIVATE=true for the app and the worker (development only).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";

const [port = "4100", secretFile = "", mode = "ok"] = process.argv.slice(2);
const TOLERANCE_SECONDS = 5 * 60;
const seen = new Set<string>();

function verify(secret: string, rawBody: string, timestamp: string | undefined, signature: string | undefined): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  return signature
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1="))
    .some((s) => {
      const given = Buffer.from(s.slice(3), "hex");
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}

http
  .createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const secret = secretFile ? readFileSync(secretFile, "utf8").trim() : "";
      const id = String(req.headers["ooohm-event-id"] ?? "");
      const verified = verify(secret, rawBody, req.headers["ooohm-timestamp"] as string, req.headers["ooohm-signature"] as string);
      const duplicate = seen.has(id);
      if (verified) seen.add(id);
      const body = verified ? (JSON.parse(rawBody) as { type: string; data: unknown }) : null;
      process.stdout.write(
        JSON.stringify({ at: new Date().toISOString(), mode, verified, duplicate, id, type: req.headers["ooohm-event-type"], data: body?.data }) + "\n",
      );
      if (!verified) return res.writeHead(400).end("bad signature");
      if (mode === "fail") return res.writeHead(500).end("receiver is failing on purpose");
      res.writeHead(200, { "Content-Type": "text/plain" }).end("received");
    });
  })
  .listen(Number(port), "127.0.0.1", () => process.stdout.write(JSON.stringify({ listening: Number(port), mode }) + "\n"));
