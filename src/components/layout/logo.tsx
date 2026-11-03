/** Wordmark: the "OOO" carries the meaning, the "hm" sits quietly beside it. */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`text-xl font-semibold tracking-tight ${className}`} aria-label="OOOhm">
      <span className="text-accent">OOO</span>
      <span className="text-muted font-normal">hm</span>
    </span>
  );
}
