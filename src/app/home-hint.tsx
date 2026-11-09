"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { cx, focusRing, textLink } from "@/components/ui/styles";

/**
 * A quiet, dismissible note on Home (days about to expire, or a nudge to subscribe to
 * the calendar). "Got it" hides it in this browser for good; the key decides what
 * counts as the same note, so next year's expiry note shows again. Keys name the person
 * and company, so someone else signing in on the same browser still sees theirs.
 *
 * Hidden until mounted, because the dismissal lives in the browser: rendering it on
 * the server would flash it for people who dismissed it.
 *
 * "Got it" takes focus with it when the note goes, so focus moves on to whatever comes
 * next on the page (or the main content) rather than falling back to the top.
 */
export function HomeHint({ storageKey, children, link }: { storageKey: string; children: React.ReactNode; link: { href: string; label: string } }) {
  const [visible, setVisible] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);

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
    setLeaving(false);
  }, [storageKey]);

  if (!visible) return null;
  const dismiss = () => {
    // Focus moves first, and the note fades out and goes a moment later: when the note
    // that held focus goes in the same instant, a screen reader (Orca) moves its own focus
    // silently and nothing is read.
    (focusableAfter(root.current) ?? document.getElementById("main"))?.focus();
    setLeaving(true);
    setTimeout(() => setVisible(false), LEAVE_MS);
    try {
      window.localStorage.setItem(storageKey, "dismissed");
    } catch {
      // Nothing to do: it stays hidden until the page reloads.
    }
  };

  return (
    <div
      ref={root}
      role="note"
      inert={leaving}
      className={cx(
        "flex flex-col gap-3 rounded-2xl border border-accent/30 bg-accent/5 p-4 sm:flex-row sm:items-center sm:justify-between",
        leaving && "pointer-events-none opacity-0 motion-safe:transition-opacity",
      )}
    >
      <p className="text-sm">{children}</p>
      <div className="flex shrink-0 items-center gap-4 text-sm">
        <Link href={link.href} className={cx(textLink, "font-medium text-accent-ink")}>
          {link.label}
        </Link>
        {/* Foreground, not muted: grey on the accent tint falls under 4.5:1 in some themes. */}
        <button type="button" onClick={dismiss} className={`inline-flex min-h-6 items-center rounded-md text-sm text-foreground underline-offset-4 hover:underline ${focusRing}`}>
          Got it
        </button>
      </div>
    </div>
  );
}

/** How long a dismissed note lingers, faded out, before it leaves the page. */
const LEAVE_MS = 200;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The first element after `el` (and outside it) that Tab would reach. */
function focusableAfter(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null;
  for (const candidate of document.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (el.contains(candidate) || !(el.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    if (candidate.offsetParent !== null || candidate.getClientRects().length > 0) return candidate;
  }
  return null;
}
