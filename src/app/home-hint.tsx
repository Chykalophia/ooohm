"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { cx, subtleButton, textLink } from "@/components/ui/styles";

/**
 * A quiet, dismissible note on Home (days about to expire, or a nudge to subscribe to
 * the calendar). "Got it" hides it in this browser for good; the key decides what
 * counts as the same note, so next year's expiry note shows again. Keys name the person
 * and company, so someone else signing in on the same browser still sees theirs.
 *
 * Hidden until mounted, because the dismissal lives in the browser: rendering it on
 * the server would flash it for people who dismissed it.
 */
export function HomeHint({ storageKey, children, link }: { storageKey: string; children: React.ReactNode; link: { href: string; label: string } }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(storageKey) === "dismissed";
    } catch {
      // Storage blocked: show it; dismissing then lasts for this page only.
    }
    // Reading the browser's storage can only happen after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisible(!dismissed);
  }, [storageKey]);

  if (!visible) return null;
  const dismiss = () => {
    setVisible(false);
    try {
      window.localStorage.setItem(storageKey, "dismissed");
    } catch {
      // Nothing to do: it stays hidden until the page reloads.
    }
  };

  return (
    <aside className="flex flex-col gap-3 rounded-2xl border border-accent/30 bg-accent/5 p-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm">{children}</p>
      <div className="flex shrink-0 items-center gap-4 text-sm">
        <Link href={link.href} className={cx(textLink, "font-medium text-accent-ink")}>
          {link.label}
        </Link>
        <button type="button" onClick={dismiss} className={subtleButton}>
          Got it
        </button>
      </div>
    </aside>
  );
}
