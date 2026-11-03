import "server-only";
import { notFound } from "next/navigation";
import type { Actor } from "@/domain/actor";
import { canAdminister } from "@/domain/admin-permissions";
import { isDomainError } from "@/domain/errors";
import { type ColorMode, colorModeOrDefault } from "@/domain/color-mode";
import { requireActor } from "@/lib/auth";
import type { ServiceContext } from "@/server/context";
import { serviceContext } from "@/server/runtime";
import { getApprovalNav } from "@/server/services/approvals";
import type { HeaderNav } from "@/components/layout/app-header";

/** A signed-in member of a company, ready to render a page, with their colour mode. */
export type MemberPage = { actor: Actor; ctx: ServiceContext; nav: HeaderNav; colorMode: ColorMode };

/** A signed-in person whose account has no company yet: the page shows {@link NoCompany} instead. */
export type CompanylessPage = { actor: null; nav: HeaderNav };

/**
 * The entry point of every signed-in page outside the admin area: the session (or a
 * redirect to sign-in), the service context, and what the header needs.
 *
 * The header's approvals count starts loading here and is read by the header, so it
 * runs alongside the page's own queries rather than before them.
 */
export async function requireMemberPage(): Promise<MemberPage | CompanylessPage> {
  const { user, actor } = await requireActor();
  const userName = user.name || user.email;
  if (!actor) return { actor: null, nav: { userName, approvals: null, member: false, admin: false } };
  return memberPage(actor, userName, colorModeOrDefault(user.colorMode));
}

function memberPage(actor: Actor, userName: string, colorMode: ColorMode): MemberPage {
  const ctx = serviceContext();
  const approvals = getApprovalNav(ctx, actor);
  // The page may bail out (a 404) before the header awaits this; mark the rejection as
  // handled so it isn't reported as unhandled. The header still sees it.
  approvals.catch(() => {});
  return { actor, ctx, nav: { userName, approvals, member: true, admin: canAdminister(actor) }, colorMode };
}

/**
 * The entry point of every admin page: the signed-in admin, or a 404 for anyone else
 * (the admin area does not announce itself). Services check the role again; this only
 * keeps non-admins from seeing the screens.
 */
export async function requireAdminPage(): Promise<MemberPage> {
  const { user, actor } = await requireActor();
  if (!actor || !canAdminister(actor)) notFound();
  return memberPage(actor, user.name || user.email, colorModeOrDefault(user.colorMode));
}

/**
 * Awaits a service read for a detail page, turning `not_found` into the 404 page. Other
 * failures propagate to the error boundary.
 */
export async function orNotFound<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (err) {
    if (isDomainError(err, "not_found")) notFound();
    throw err;
  }
}
