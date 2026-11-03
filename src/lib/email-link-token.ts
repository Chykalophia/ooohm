import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed links in emails that act without a session ("Approve" in a request email).
 *
 * A token is `<claims>.<signature>`, both base64url: the claims are JSON naming the
 * request, the approver the email went to, and an expiry; the signature is
 * HMAC-SHA256 over the claims under a key derived from `BETTER_AUTH_SECRET`
 * ({@link deriveLinkKey}). Nothing is stored. A token is good for one decision because
 * the request it names stops being pending once decided, and the service re-checks on
 * use that the approver may still decide it.
 */
export interface ApproveLinkClaims {
  requestId: string;
  approverId: string;
  /** Unix seconds. */
  expiresAt: number;
}

/** How long an approve link works after its email is sent. */
export const APPROVE_LINK_DAYS = 7;

/** Separates this key from every other use of the auth secret. */
const KEY_LABEL = "ooohm/email-link/v1";

/** The signing key for email links, from the app's auth secret. */
export function deriveLinkKey(secret: string): string {
  return createHmac("sha256", secret).update(KEY_LABEL).digest("base64url");
}

function sign(key: string, body: string): string {
  return createHmac("sha256", key).update(body).digest("base64url");
}

/** A token for `claims`, signed with `key`. */
export function signApproveToken(key: string, claims: ApproveLinkClaims): string {
  const body = Buffer.from(JSON.stringify({ r: claims.requestId, a: claims.approverId, e: claims.expiresAt })).toString("base64url");
  return `${body}.${sign(key, body)}`;
}

export type ApproveTokenCheck = { ok: true; claims: ApproveLinkClaims } | { ok: false; reason: "invalid" | "expired" };

/**
 * Checks a token's shape, signature (in constant time) and expiry. `invalid` covers
 * anything malformed or signed with another key; only a genuine token can be `expired`.
 */
export function verifyApproveToken(key: string, token: string, now: Date): ApproveTokenCheck {
  if (token.length > 512) return { ok: false, reason: "invalid" };
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return { ok: false, reason: "invalid" };
  const expected = Buffer.from(sign(key, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "invalid" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const { r, a, e } = (parsed ?? {}) as { r?: unknown; a?: unknown; e?: unknown };
  if (typeof r !== "string" || typeof a !== "string" || typeof e !== "number" || !Number.isFinite(e)) return { ok: false, reason: "invalid" };
  if (now.getTime() / 1000 >= e) return { ok: false, reason: "expired" };
  return { ok: true, claims: { requestId: r, approverId: a, expiresAt: e } };
}
