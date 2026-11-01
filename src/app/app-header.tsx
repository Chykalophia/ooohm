import Link from "next/link";
import { Logo } from "@/components/logo";
import { SignOutButton } from "./sign-out-button";

/** Shared top bar for signed-in pages. The Approvals link appears only when it is useful. */
export function AppHeader({
  userName,
  approvals,
  current,
}: {
  userName: string;
  approvals: { visible: boolean; pending: number } | null;
  current: "home" | "approvals";
}) {
  return (
    <header className="mb-10 flex flex-wrap items-center justify-between gap-4">
      <Link href="/" className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent">
        <Logo />
      </Link>
      <nav aria-label="Main" className="flex items-center gap-5 text-sm">
        {approvals?.visible && (
          <Link
            href="/approvals"
            aria-current={current === "approvals" ? "page" : undefined}
            className={`rounded-md hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent ${
              current === "approvals" ? "font-medium text-foreground" : "text-muted"
            }`}
          >
            Approvals
            {approvals.pending > 0 && " "}
            {approvals.pending > 0 && (
              <span className="ml-0.5 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground tabular-nums">
                {approvals.pending}
                <span className="sr-only"> waiting</span>
              </span>
            )}
          </Link>
        )}
        <span className="text-muted">{userName}</span>
        <SignOutButton />
      </nav>
    </header>
  );
}
