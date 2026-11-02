import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { isBlockedAddress, isIpLiteral, type TargetPolicy } from "@/domain/webhook-target";

/**
 * The transport a webhook delivery POSTs through. The worker uses
 * {@link createSafeFetch}; tests pass a fake. It never follows redirects.
 */
export type WebhookFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<Response>;

/** Most response bytes read; the rest is discarded unread. Only a short excerpt is ever stored. */
export const MAX_RESPONSE_BYTES = 64 * 1024;

/** A delivery the transport refused before or while connecting, with a short, loggable code. */
export class TransportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TransportError";
  }
}

/**
 * A `lookup` for `http.request` that resolves every address of the host and refuses the
 * connection when any of them is blocked. The check runs on the very answer the socket
 * connects to, so a name that changes between a check and the connection (DNS
 * rebinding) cannot slip through.
 */
function guardedLookup(policy: TargetPolicy): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
      if (err) return callback(err, "", 0);
      if (!policy.allowPrivate && (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address)))) {
        return callback(new TransportError("blocked_address"), "", 0);
      }
      if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

/**
 * A {@link WebhookFetch} on Node's `http`/`https` with server-side request forgery
 * protection:
 *
 * - `https:` only, unless `policy.allowInsecure`;
 * - every address the host resolves to is checked at connect time, and an IP literal
 *   before connecting, against the blocked ranges (`isBlockedAddress`), unless
 *   `policy.allowPrivate`;
 * - redirects are never followed (a 3xx is a failed attempt);
 * - at most {@link MAX_RESPONSE_BYTES} of the response body are read.
 *
 * The caller's `signal` bounds the whole request (the worker passes 10 seconds).
 */
export function createSafeFetch(policy: TargetPolicy): WebhookFetch {
  const lookup = guardedLookup(policy);
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        return reject(new TransportError("invalid_url"));
      }
      const secure = target.protocol === "https:";
      if (!secure && !(target.protocol === "http:" && policy.allowInsecure)) return reject(new TransportError("insecure_url"));
      if (isIpLiteral(target.hostname) && !policy.allowPrivate && isBlockedAddress(target.hostname)) {
        return reject(new TransportError("blocked_address"));
      }
      if (init.signal.aborted) return reject(new TransportError("timeout"));

      const request = (secure ? https : http).request(
        target,
        { method: init.method, headers: { ...init.headers, "Content-Length": String(Buffer.byteLength(init.body)) }, lookup, signal: init.signal },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const finish = () => {
            const status = res.statusCode ?? 0;
            if (status < 200 || status > 599) return reject(new TransportError("invalid_status"));
            const headers = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
            }
            const nullBody = status === 204 || status === 205 || status === 304;
            resolve(new Response(nullBody ? null : Buffer.concat(chunks), { status, headers }));
          };
          res.on("data", (chunk: Buffer) => {
            if (size >= MAX_RESPONSE_BYTES) return;
            const room = MAX_RESPONSE_BYTES - size;
            chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
            size += Math.min(chunk.length, room);
            if (size >= MAX_RESPONSE_BYTES) {
              // Enough read: stop downloading and answer with what we have.
              res.removeAllListeners("data");
              res.destroy();
              finish();
            }
          });
          res.on("end", finish);
          res.on("error", (err) => (size >= MAX_RESPONSE_BYTES ? undefined : reject(err)));
        },
      );
      request.on("error", (err) => {
        if (init.signal.aborted) return reject(new TransportError("timeout"));
        reject(err instanceof TransportError ? err : (err.cause instanceof TransportError ? err.cause : err));
      });
      request.end(init.body);
    });
}

/**
 * A short, non-identifying description of a failed attempt for the delivery log:
 * `timeout`, `blocked_address`, `ECONNREFUSED`, `CERT_HAS_EXPIRED`... Never a URL or a
 * response body.
 */
export function describeTransportError(err: unknown): string {
  if (err instanceof TransportError) return err.code;
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return "timeout";
    const code = (err as Error & { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code)) return code;
    return err.name.slice(0, 40) || "error";
  }
  return "error";
}
