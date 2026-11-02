import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Whether an `Authorization` header carries `Bearer <secret>`, the way Vercel Cron (and
 * any scheduler configured like it) calls `/api/cron/tick`.
 *
 * Both sides are hashed first, so the comparison is constant-time whatever their lengths
 * and reveals nothing about the secret through timing. A missing secret authorizes
 * nothing: the route stays shut until `CRON_SECRET` is set.
 */
export function isCronAuthorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  const given = createHash("sha256").update(match[1]).digest();
  const expected = createHash("sha256").update(secret).digest();
  return timingSafeEqual(given, expected);
}
