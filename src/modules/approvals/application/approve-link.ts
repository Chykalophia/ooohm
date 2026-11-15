import "server-only";
import { APPROVE_LINK_DAYS, signApproveToken } from "@/lib/email-link-token";
import type { LinkSigner } from "./ports";

/**
 * The Approve link for a request email to `approverId`, or `null` where links cannot be
 * signed (a process without the key). Valid for {@link APPROVE_LINK_DAYS} days.
 */
export function approveLinkFor(signer: LinkSigner, requestId: string, approverId: string): string | null {
  if (!signer.linkKey) return null;
  const expiresAt = Math.floor(signer.now().getTime() / 1000) + APPROVE_LINK_DAYS * 86_400;
  return `${signer.appUrl}/approve/${signApproveToken(signer.linkKey, { requestId, approverId, expiresAt })}`;
}
