/**
 * The waiting indicator: the three O's of the name, where the last one keeps stepping
 * out (it empties to a ring and comes back). A small nod to the wordmark. Decorative:
 * whatever it sits beside says what is happening. With reduced motion it holds still,
 * last O hollow.
 */
export function OooDots({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="1 11 30 10" aria-hidden="true" className={`ooo-dots inline-block h-[0.55em] w-[1.65em] ${className}`}>
      <circle cx="6" cy="16" r="4.3" />
      <circle cx="16" cy="16" r="4.3" />
      <circle cx="26" cy="16" r="3.3" />
    </svg>
  );
}

/** A busy button's label, "Saving…" say, with the dots standing in for the ellipsis. */
export function PendingLabel({ label }: { label: string }) {
  const text = label.replace(/(…|\.\.\.)$/, "");
  return (
    <span className="inline-flex items-baseline gap-1.5">
      {text}
      <OooDots />
    </span>
  );
}
