import Link from "next/link";
import { use } from "react";
import { REQUEST_FORM_ID } from "./anchors";
import { SteadyLabel } from "@/components/ui/steady-label";
import { buttonClass, cx, focusRing } from "@/components/ui/styles";
import { AccountMenu } from "./account-menu";
import { Logo } from "./logo";

/** Which header link marks the page. "requests" (Your requests) is reached from the account menu, so no link is marked. */
export type HeaderSection = "home" | "calendar" | "team" | "approvals" | "admin" | "account" | "requests";

/** Whether to show the Approvals link, and how many requests wait there. */
export type ApprovalNav = { visible: boolean; pending: number };

/** Who the header is for: everything it needs to decide which links to show. */
export type HeaderNav = {
  userName: string;
  /** Unresolved while it loads alongside the page's own data; `null` without a company. */
  approvals: ApprovalNav | Promise<ApprovalNav> | null;
  /** True for members of a company; false shows only the person's own menu. */
  member: boolean;
  /** True for admins: shows the Admin link. */
  admin: boolean;
};

function NavLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cx("inline-flex min-h-6 items-center rounded-md hover:text-foreground", focusRing, active ? "text-foreground" : "text-muted")}
    >
      <SteadyLabel bold={active}>{children}</SteadyLabel>
    </Link>
  );
}

/**
 * Shared top bar for signed-in pages. Calendar and Team are always there for members
 * of a company; the Approvals link appears only when it is useful (and always on the
 * Approvals page itself, even after its last request is decided), and Admin only for
 * admins (the admin pages and services check the role again themselves).
 *
 * "Request time off" is on every page but the dashboard, where the form itself is, so
 * nobody has to know the logo leads to it. It is an accent outline, so each page's own
 * main action stays the one filled button. The person's name opens their own options
 * ({@link AccountMenu}).
 *
 * The header is the same size, with every link in the same place, on every page: the
 * current link's bold never changes its width ({@link SteadyLabel}), and on the
 * dashboard an invisible copy of "Request time off" keeps its place.
 */
export function AppHeader({ nav, current }: { nav: HeaderNav; current: HeaderSection }) {
  // `use` rather than `await`, so the header stays an ordinary component: it renders
  // from a server page today and could from a client one.
  const approvals = nav.approvals instanceof Promise ? use(nav.approvals) : nav.approvals;
  const showApprovals = approvals !== null && (approvals.visible || current === "approvals");
  return (
    <header className="mb-10 flex flex-wrap items-center justify-between gap-4">
      <Link href="/" className={cx("rounded-md", focusRing)}>
        <Logo />
      </Link>
      <nav aria-label="Main" className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        {nav.member && (
          <>
            <NavLink href="/calendar" active={current === "calendar"}>
              Calendar
            </NavLink>
            <NavLink href="/team" active={current === "team"}>
              Team
            </NavLink>
          </>
        )}
        {showApprovals && (
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
        {nav.admin && (
          <NavLink href="/admin/people" active={current === "admin"}>
            Admin
          </NavLink>
        )}
        <AccountMenu userName={nav.userName} member={nav.member} active={current === "account"} />
        {nav.member &&
          (current === "home" ? (
            // Holds the button's place (visibility: hidden, so it is neither seen, read nor focused).
            <span aria-hidden className={cx(buttonClass("accent", "sm"), "invisible")}>
              Request time off
            </span>
          ) : (
            <Link href={`/#${REQUEST_FORM_ID}`} className={buttonClass("accent", "sm")}>
              Request time off
            </Link>
          ))}
      </nav>
    </header>
  );
}
