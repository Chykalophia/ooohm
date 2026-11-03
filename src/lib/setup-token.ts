import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Whether `given` is the install's `SETUP_TOKEN`, compared in constant time. Both are
 * hashed first, so their lengths never show in the timing either. Always false when no
 * token is configured: then the web setup is off.
 */
export function setupTokenMatches(given: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(given), digest(expected));
}
