"use client";

import { useId, useRef, useState } from "react";
import { primaryButton } from "@/app/styles";

/**
 * A read-only value with a copy button, for a secret shown once (an API key, a feed
 * link). Where the clipboard is refused, the value is selected instead and the person
 * is told to copy it themselves.
 *
 * Renders a fragment (label, field row, status line), so the caller's spacing applies.
 *
 * @param selectedText What the fallback says is selected, e.g. "The link is selected."
 */
export function CopyField({
  label,
  value,
  copyLabel = "Copy",
  selectedText = "It's selected.",
}: {
  label: string;
  value: string;
  copyLabel?: string;
  selectedText?: string;
}) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "manual">("idle");

  async function copyValue() {
    try {
      await navigator.clipboard.writeText(value);
      setCopy("copied");
    } catch {
      input.current?.select();
      setCopy("manual");
    }
  }

  return (
    <>
      <label htmlFor={inputId} className="block text-sm font-medium">
        {label}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={inputId}
          ref={input}
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full min-w-0 rounded-lg border border-field bg-background px-3 py-2 font-mono text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
        <button type="button" onClick={copyValue} className={`${primaryButton} shrink-0`}>
          {copyLabel}
        </button>
      </div>
      <p aria-live="polite" className="min-h-5 text-sm text-accent-ink">
        {copy === "copied" && "Copied."}
        {copy === "manual" && <span className="text-foreground">{selectedText} Press Ctrl+C (⌘C on a Mac) to copy it.</span>}
      </p>
    </>
  );
}
