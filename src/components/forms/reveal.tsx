"use client";

import { useEffect, useRef, useState } from "react";
import { subtleButton } from "@/components/ui/styles";

/** The controls focus can land on when the edit form opens. */
const FOCUSABLE = "input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])";

/**
 * Shows `children` (an edit form) only after "Change" is clicked, so a list stays calm.
 *
 * Opening and closing each swap out the button that was just pressed, so focus is moved
 * on purpose rather than dropped to the page: into the form's first field when it opens,
 * back to the opener when it closes. Not on first render, so a page that starts with it
 * open does not steal focus.
 */
export function Reveal({
  label,
  ariaLabel,
  children,
  open: initiallyOpen = false,
}: {
  label: string;
  /** Names the button for screen readers when a list repeats `label` ("Change", "Rename"). */
  ariaLabel?: string;
  children: React.ReactNode;
  open?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const toggled = useRef(false);

  useEffect(() => {
    if (!toggled.current) return;
    toggled.current = false;
    if (open) panel.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    else opener.current?.focus();
  }, [open]);

  const toggle = (next: boolean) => {
    toggled.current = true;
    setOpen(next);
  };

  if (!open) {
    return (
      <button ref={opener} type="button" onClick={() => toggle(true)} className={subtleButton} aria-expanded={false} aria-label={ariaLabel}>
        {label}
      </button>
    );
  }
  return (
    <div ref={panel} className="space-y-3">
      {children}
      <button
        type="button"
        onClick={() => toggle(false)}
        className={subtleButton}
        aria-expanded
        aria-label={ariaLabel ? `Close: ${ariaLabel}` : undefined}
      >
        Close
      </button>
    </div>
  );
}
