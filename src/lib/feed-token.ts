import { createHash, randomBytes } from "node:crypto";

/**
 * Calendar feed tokens: the secret part of a feed URL.
 *
 * A token is 32 random bytes in base64url (43 characters). Only its SHA-256 hash is
 * stored, so a copy of the database cannot be turned back into working links. A plain
 * hash is enough here (no salt or slow KDF): the input is 256 random bits, not a
 * guessable password.
 */
export const FEED_TOKEN_BYTES = 32;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** A new feed token: {@link FEED_TOKEN_BYTES} random bytes, base64url (43 characters). Store only its hash. */
export function generateFeedToken(): string {
  return randomBytes(FEED_TOKEN_BYTES).toString("base64url");
}

/** The stored form of a token: its SHA-256, as 64 lowercase hex characters. */
export function hashFeedToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** True for a string shaped like a token from {@link generateFeedToken}. */
export function isFeedTokenShape(value: string): boolean {
  return TOKEN_SHAPE.test(value);
}

/**
 * The token in a feed file name, `<token>.ics`, or `null` when the name has any other
 * shape. Lets the route answer 404 without touching the database.
 */
export function tokenFromFeedFileName(fileName: string): string | null {
  if (!fileName.endsWith(".ics")) return null;
  const token = fileName.slice(0, -".ics".length);
  return isFeedTokenShape(token) ? token : null;
}

/** The feed's URL path for a token. */
export function feedPath(token: string): string {
  return `/api/ics/${token}.ics`;
}

/**
 * A short, non-secret label for logs: the first 8 hex characters of the token's hash.
 * Never log the token itself; it is a working link.
 */
export function feedLogId(token: string): string {
  return hashFeedToken(token).slice(0, 8);
}
