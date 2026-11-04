"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/leave/status-badge";
import { Card } from "@/components/ui/card";
import { cx } from "@/components/ui/styles";
import { type Decision, DecisionForm } from "./decision-form";

/** How long a decided request stays on screen, showing its outcome, before it leaves. */
const HOLD_MS = 1600;
/** How long it takes to fold away; matches the transition below. */
const COLLAPSE_MS = 300;

/**
 * One request in the Needs you list. Deciding it turns the card into its outcome (an
 * Approved or Declined badge and what that means), holds that for a moment, then folds
 * the card away and refreshes the page, so the tab and navigation counts follow without
 * a reload. A decided card drops out of the J/K shortcuts at once, and if it had focus,
 * focus moves to the next request (else the previous one) before it goes.
 *
 * @param label The card's accessible name: who asked, and for which dates.
 * @param who The requester's name (or email), for the outcome line.
 * @param dates The request's dates as people read them, for the outcome line.
 */
export function ApprovalItem({
  requestId,
  label,
  who,
  dates,
  children,
}: {
  requestId: string;
  label: string;
  who: string;
  dates: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const item = useRef<HTMLLIElement>(null);
  const outcome = useRef<HTMLDivElement>(null);
  const [decided, setDecided] = useState<Decision | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!decided) return;
    // The outcome replaces the form, including the button that had focus. Take focus only
    // if it was here (or was lost with the form), not if the person has moved on.
    const active = document.activeElement;
    if (!active || active === document.body || item.current?.contains(active)) outcome.current?.focus();
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fold = window.setTimeout(() => setLeaving(true), HOLD_MS);
    const done = window.setTimeout(
      () => {
        const el = item.current;
        if (el?.contains(document.activeElement)) {
          // This card has already left the shortcut list, so these are the requests still open.
          const open = [...document.querySelectorAll<HTMLElement>("[data-approval]")];
          const after = open.find((c) => el.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING);
          (after ?? open.at(-1))?.focus();
        }
        router.refresh();
      },
      HOLD_MS + (still ? 0 : COLLAPSE_MS),
    );
    return () => {
      window.clearTimeout(fold);
      window.clearTimeout(done);
    };
  }, [decided, router]);

  const approved = decided === "approve";
  return (
    <li
      ref={item}
      className={cx(
        "grid motion-safe:transition-[grid-template-rows,opacity] motion-safe:duration-300 motion-safe:ease-out",
        leaving ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]",
      )}
    >
      <div className={cx("min-h-0", leaving && "overflow-hidden")}>
        <Card
          as="div"
          data-approval={decided ? undefined : ""}
          role="group"
          tabIndex={-1}
          aria-label={label}
          className={cx(
            "relative isolate space-y-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink",
            "motion-safe:transition-[box-shadow,opacity] motion-safe:duration-300",
            decided && (approved ? "ring-2 ring-accent" : "opacity-80 ring-1 ring-border"),
          )}
        >
          {/* A wash of the accent over an approved card, faded in. */}
          {decided && approved && (
            <span aria-hidden className="ooo-fade pointer-events-none absolute inset-0 -z-10 m-0 rounded-[inherit] bg-accent/10" />
          )}
          {children}
          {decided ? (
            <div ref={outcome} tabIndex={-1} role="status" className="relative flex items-start gap-3 outline-none">
              <span
                aria-hidden
                className={cx(
                  "ooo-pop grid h-8 w-8 shrink-0 place-items-center rounded-full",
                  approved ? "bg-accent text-accent-foreground" : "border border-danger-border text-danger",
                )}
              >
                <svg viewBox="0 0 16 16" className="h-4 w-4">
                  <path
                    d={approved ? "M3.5 8.5 6.5 11.5 12.5 4.5" : "M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5"}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <div className="min-w-0 space-y-0.5">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <StatusBadge status={approved ? "approved" : "rejected"} />
                  <span className={approved ? "text-accent-ink" : "text-foreground"}>
                    {approved ? `${who} is off ${dates}.` : `${who}’s request for ${dates} is declined.`}
                  </span>
                </p>
                <p className="text-xs text-muted">Moving it to Settled.</p>
              </div>
            </div>
          ) : (
            <DecisionForm requestId={requestId} onDecided={setDecided} />
          )}
        </Card>
      </div>
    </li>
  );
}
