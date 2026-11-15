import "server-only";
import { APPROVE_LINK_DAYS, signApproveToken } from "@/lib/email-link-token";
import type { ServiceContext } from "@/server/context";

/**
 * The Approve link for a request email to `approverId`, or `null` where links cannot be
 * signed (a process without the key). Valid for {@link APPROVE_LINK_DAYS} days.
 */
export function approveLinkFor(ctx: ServiceContext, requestId: string, approverId: string): string | null {
  if (!ctx.linkKey) return null;
  const expiresAt = Math.floor(ctx.now().getTime() / 1000) + APPROVE_LINK_DAYS * 86_400;
  return `${ctx.appUrl}/approve/${signApproveToken(ctx.linkKey, { requestId, approverId, expiresAt })}`;
}
