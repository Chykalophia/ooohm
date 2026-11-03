"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { SteadyLabel } from "@/components/ui/steady-label";
import { cx, focusRing } from "@/components/ui/styles";
import { SignOutButton } from "@/components/layout/sign-out-button";

/** One row of the menu: the whole row is the target, highlighted on hover. */
const row = `block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-background ${focusRing}`;
const item = cx(row, "text-foreground");
/** Sign out: the same row, quieter. */
const quietItem = cx(row, "text-muted hover:text-foreground");

/**
 * The signed-in person's name in the header, opening their personal options: their
 * account settings, calendar subscriptions (members of a company only) and sign out.
 *
 * A disclosure, not an ARIA menu: a button that shows a short list of ordinary links,
 * which keyboard and screen reader users already know how to use. Escape closes it and
 * returns focus to the button; a click outside or a navigation closes it too. On narrow
 * screens the header wraps and the name sits at the left, so the panel opens rightwards.
 */
export function AccountMenu({ userName, member, active }: { userName: string; member: boolean; active: boolean }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();

  // Close after navigating, e.g. to the account page.
  const [shownFor, setShownFor] = useState(pathname);
  if (shownFor !== pathname) {
    setShownFor(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1 rounded-md hover:text-foreground ${focusRing} ${active || open ? "text-foreground" : "text-muted"}`}
      >
        {/* Bold only on the account page (the current page, like the other links), never just for being open. */}
        <span className="flex min-w-0 max-w-[12rem]">
          <SteadyLabel bold={active} truncate>
            {userName}
          </SteadyLabel>
        </span>
        <svg aria-hidden viewBox="0 0 20 20" className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} fill="currentColor">
          <path d="M5.25 7.5 10 12.25 14.75 7.5z" />
        </svg>
      </button>
      {open && (
        <div
          id={panelId}
          className="absolute left-0 z-20 mt-2 w-56 space-y-1 rounded-xl border border-border bg-surface p-1.5 shadow-lg sm:left-auto sm:right-0"
        >
          <ul className="space-y-0.5">
            {member && (
              <>
                <li>
                  <Link href="/account" className={item} aria-current={pathname === "/account" ? "page" : undefined}>
                    Your account
                  </Link>
                </li>
                <li>
                  <Link
                    href="/calendar/subscriptions"
                    className={item}
                    aria-current={pathname === "/calendar/subscriptions" ? "page" : undefined}
                  >
                    Calendar subscriptions
                  </Link>
                </li>
              </>
            )}
          </ul>
          <div className={member ? "border-t border-border pt-1" : undefined}>
            <SignOutButton className={quietItem} />
          </div>
        </div>
      )}
    </div>
  );
}
