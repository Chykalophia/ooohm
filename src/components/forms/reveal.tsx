"use client";

import { useState } from "react";
import { subtleButton } from "@/components/ui/styles";

/** Shows `children` (an edit form) only after "Change" is clicked, so a list stays calm. */
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
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={subtleButton} aria-expanded={false} aria-label={ariaLabel}>
        {label}
      </button>
    );
  }
  return (
    <div className="space-y-3">
      {children}
      <button
        type="button"
        onClick={() => setOpen(false)}
        className={subtleButton}
        aria-expanded
        aria-label={ariaLabel ? `Close: ${ariaLabel}` : undefined}
      >
        Close
      </button>
    </div>
  );
}
