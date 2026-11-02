import Link from "next/link";
import { Logo } from "@/components/logo";
import { SignOutButton } from "./sign-out-button";
import { focusRing } from "@/app/styles";

export type HeaderSection = "home" | "calendar" | "team" | "approvals" | "admin";

function NavLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-md ${focusRing} hover:text-foreground ${active ? "font-medium text-foreground" : "text-muted"}`}
    >
      {children}
    </Link>
  );
}

/**
 * Shared top bar for signed-in pages. Calendar and Team are always there for members
 * of a company; the Approvals link appears only when it is useful, and Admin only for
 * admins (the admin pages and services check the role again themselves).
 */
export function AppHeader({
  userName,
  approvals,
  current,
  member = true,
  admin = false,
}: {
  userName: string;
  approvals: { visible: boolean; pending: number } | null;
  current: HeaderSection;
  /** False while the account has no company, so there is nothing to link to. */
  member?: boolean;
  /** True for admins: shows the Admin link. */
  admin?: boolean;
}) {
  return (
    <header className="mb-10 flex flex-wrap items-center justify-between gap-4">
      <Link href="/" className={`rounded-md ${focusRing}`}>
        <Logo />
      </Link>
      <nav aria-label="Main" className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        {member && (
          <>
            <NavLink href="/calendar" active={current === "calendar"}>
              Calendar
            </NavLink>
            <NavLink href="/team" active={current === "team"}>
              Team
            </NavLink>
          </>
        )}
        {approvals?.visible && (
          <NavLink href="/approvals" active={current === "approvals"}>
            Approvals
            {approvals.pending > 0 && " "}
            {approvals.pending > 0 && (
              <span className="ml-0.5 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground tabular-nums">
                {approvals.pending}
                <span className="sr-only"> waiting</span>
              </span>
            )}
          </NavLink>
        )}
        {admin && (
          <NavLink href="/admin/people" active={current === "admin"}>
            Admin
          </NavLink>
        )}
        <span className="text-muted">{userName}</span>
        <SignOutButton />
      </nav>
    </header>
  );
}
