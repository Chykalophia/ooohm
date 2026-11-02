import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hashToken } from "./token-hash";

/**
 * Secrets of the integration layer: encryption of webhook signing secrets at rest,
 * webhook signatures, and API keys. Never log anything these functions take or return
 * except {@link apiKeyPrefix}.
 */

/**
 * Seals and opens short secrets with AES-256-GCM. The signer needs a webhook secret's
 * plaintext, so it is encrypted rather than hashed; a copy of the database alone does
 * not reveal it.
 */
export interface SecretBox {
  /**
   * @param context Bound into the ciphertext as additional data (the endpoint id), so a
   *   sealed value copied onto another row does not open there.
   */
  seal(plaintext: string, context: string): string;
  /** @throws Error when the value was tampered with, sealed for another context, or with another key. */
  open(sealed: string, context: string): string;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SEALED_PREFIX = "v1";

/** The 32-byte key in `WEBHOOK_ENCRYPTION_KEY` (standard base64), or `null` when it is not exactly that. */
export function parseEncryptionKey(base64: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64.trim())) return null;
  const key = Buffer.from(base64.trim(), "base64");
  return key.length === KEY_BYTES ? key : null;
}

/**
 * @param keyBase64 32 random bytes in base64, e.g. from `openssl rand -base64 32`.
 * @throws Error when the key is not 32 bytes.
 */
export function createSecretBox(keyBase64: string): SecretBox {
  const key = parseEncryptionKey(keyBase64);
  if (!key) throw new Error("The encryption key must be 32 bytes in base64 (openssl rand -base64 32).");
  return {
    seal(plaintext, context) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.from(context, "utf8"));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [SEALED_PREFIX, iv.toString("base64url"), body.toString("base64url"), tag.toString("base64url")].join(".");
    },
    open(sealed, context) {
      const [version, iv, body, tag] = sealed.split(".");
      if (version !== SEALED_PREFIX || !iv || body === undefined || !tag) throw new Error("Not a sealed secret.");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
    },
  };
}

/** A box for processes that hold no key (the rollover job): it refuses to seal or open anything. */
export function unavailableSecretBox(reason: string): SecretBox {
  const refuse = (): never => {
    throw new Error(reason);
  };
  return { seal: refuse, open: refuse };
}

const WEBHOOK_SECRET_PREFIX = "whsec_";

/** A new signing secret: `whsec_` and 32 random bytes in base64url. The whole string is the HMAC key. */
export function generateWebhookSecret(): string {
  return WEBHOOK_SECRET_PREFIX + randomBytes(32).toString("base64url");
}

/** The message a signature covers: `${timestamp}.${rawBody}`, so a body cannot be replayed with a new timestamp. */
export function signedPayload(timestamp: number, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/** HMAC-SHA256 of `${timestamp}.${rawBody}` with the secret (its UTF-8 bytes) as the key, in lowercase hex. */
export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(signedPayload(timestamp, rawBody), "utf8").digest("hex");
}

export const WEBHOOK_HEADERS = {
  eventId: "OOOhm-Event-Id",
  eventType: "OOOhm-Event-Type",
  timestamp: "OOOhm-Timestamp",
  signature: "OOOhm-Signature",
} as const;

/** Every header of one delivery attempt. `timestamp` is unix seconds at the attempt, so each retry is signed afresh. */
export function webhookRequestHeaders(input: { secret: string; eventId: string; eventType: string; timestamp: number; body: string }) {
  return {
    "Content-Type": "application/json",
    "User-Agent": "OOOhm-Webhooks/1",
    [WEBHOOK_HEADERS.eventId]: input.eventId,
    [WEBHOOK_HEADERS.eventType]: input.eventType,
    [WEBHOOK_HEADERS.timestamp]: String(input.timestamp),
    [WEBHOOK_HEADERS.signature]: `v1=${signWebhook(input.secret, input.timestamp, input.body)}`,
  };
}

/** Five minutes: how far a receiver should let `OOOhm-Timestamp` be from its own clock. */
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * What a receiver does with a delivery (docs/api.md shows the same steps): recompute the
 * signature over the raw body, compare in constant time against every `v1=` value in the
 * header, and refuse a timestamp outside the tolerance.
 */
export function verifyWebhookSignature(input: {
  secret: string;
  rawBody: string;
  timestampHeader: string | null;
  signatureHeader: string | null;
  nowSeconds: number;
  toleranceSeconds?: number;
}): boolean {
  const { secret, rawBody, timestampHeader, signatureHeader, nowSeconds } = input;
  if (!timestampHeader || !signatureHeader || !/^\d{1,12}$/.test(timestampHeader)) return false;
  const timestamp = Number(timestampHeader);
  if (Math.abs(nowSeconds - timestamp) > (input.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS)) return false;
  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody), "hex");
  return signatureHeader
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1="))
    .some((part) => {
      const given = Buffer.from(part.slice(3), "hex");
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}

const API_KEY_PREFIX = "ooohm_";
const API_KEY_SHAPE = /^ooohm_[A-Za-z0-9_-]{43}$/;
/** Characters after `ooohm_` shown to admins to tell keys apart. */
const SHOWN_CHARS = 8;

/** A new key: `ooohm_` and 32 random bytes in base64url. Shown once; only its hash is stored. */
export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const key = API_KEY_PREFIX + randomBytes(32).toString("base64url");
  return { key, hash: hashToken(key), prefix: apiKeyPrefix(key) };
}

/** What admins see of a key, e.g. `ooohm_AbCdEfGh`. Not secret on its own: 208 random bits stay hidden. */
export function apiKeyPrefix(key: string): string {
  return key.slice(0, API_KEY_PREFIX.length + SHOWN_CHARS);
}

export function isApiKeyShape(value: string): boolean {
  return API_KEY_SHAPE.test(value);
}

/** The key in an `Authorization: Bearer <key>` header, or `null` for any other shape. */
export function apiKeyFromAuthorization(header: string | null): string | null {
  const match = header ? /^Bearer +(\S+) *$/i.exec(header) : null;
  return match && isApiKeyShape(match[1]) ? match[1] : null;
}

/** Constant-time equality of two hex digests. */
export function sameDigest(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
