import { createHash } from "node:crypto";

/**
 * The stored form of a random secret token (an API key, a calendar feed token): its
 * SHA-256, as 64 lowercase hex characters. A plain hash is enough, with no salt or slow
 * KDF, because the input is 256 random bits, not a guessable password. Never use it
 * for passwords.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
