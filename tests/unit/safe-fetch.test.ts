import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { createSafeFetch, describeTransportError, MAX_RESPONSE_BYTES, TransportError } from "@/lib/safe-fetch";

/**
 * The worker's transport against a real local server. Loopback is exactly what it must
 * refuse in production, so the refusals are tested with the strict policy and the
 * happy paths with the development flags.
 */
describe("safe webhook transport", () => {
  let server: http.Server;
  let port = 0;
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];

  before(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        if (req.url === "/redirect") {
          res.writeHead(302, { Location: "http://example.com/" });
          return res.end();
        }
        if (req.url === "/big") {
          res.writeHead(200, { "Content-Type": "text/plain" });
          return res.end("x".repeat(MAX_RESPONSE_BYTES * 3));
        }
        if (req.url === "/slow") return setTimeout(() => res.end("late"), 2_000);
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const post = (fetch: ReturnType<typeof createSafeFetch>, url: string, signal = AbortSignal.timeout(5_000)) =>
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Test": "1" }, body: '{"a":1}', signal });
  const dev = createSafeFetch({ allowInsecure: true, allowPrivate: true });

  test("posts the body and headers, and reports the status", async () => {
    const res = await post(dev, `http://127.0.0.1:${port}/ok`);
    assert.equal(res.status, 204);
    const last = received.at(-1)!;
    assert.equal(last.body, '{"a":1}');
    assert.equal(last.headers["x-test"], "1");
    assert.equal(last.headers["content-length"], "7");
  });

  test("never follows a redirect", async () => {
    const before = received.length;
    const res = await post(dev, `http://127.0.0.1:${port}/redirect`);
    assert.equal(res.status, 302);
    assert.equal(received.length, before + 1, "only the one request");
  });

  test("reads at most 64 KB of a response", async () => {
    const res = await post(dev, `http://127.0.0.1:${port}/big`);
    assert.equal((await res.arrayBuffer()).byteLength, MAX_RESPONSE_BYTES);
  });

  test("the caller's signal times a slow endpoint out", async () => {
    await assert.rejects(post(dev, `http://127.0.0.1:${port}/slow`, AbortSignal.timeout(200)), (err) => describeTransportError(err) === "timeout");
  });

  test("refuses loopback by IP literal and by name (resolved at connect time), and plain http, under the strict policy", async () => {
    const strict = createSafeFetch({ allowInsecure: true, allowPrivate: false });
    const before = received.length;
    for (const url of [`http://127.0.0.1:${port}/x`, `http://localhost:${port}/x`, `http://[::ffff:127.0.0.1]:${port}/x`]) {
      await assert.rejects(post(strict, url), (err) => err instanceof TransportError && err.code === "blocked_address", url);
    }
    assert.equal(received.length, before, "nothing reached the server");
    await assert.rejects(post(createSafeFetch({ allowInsecure: false, allowPrivate: true }), `http://127.0.0.1:${port}/x`), (err) =>
      err instanceof TransportError && err.code === "insecure_url",
    );
  });

  test("connection failures are described by code, never by URL", async () => {
    const closed = await new Promise<number>((resolve) => {
      const s = http.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    await assert.rejects(post(dev, `http://127.0.0.1:${closed}/x`), (err) => describeTransportError(err) === "ECONNREFUSED");
  });
});
