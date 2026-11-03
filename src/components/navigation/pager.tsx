import Link from "next/link";
import { outlineButton, quietLink } from "@/components/ui/styles";

/** Where the pager's links lead; `null` hides one. Built by the page (`pagerLinks`). */
export type PagerLinks = {
  /** The page's position, from 1, as the links counted it. */
  number: number;
  /** Back to page 1, offered from page 3 on (on page 2, Previous is page 1). */
  first: string | null;
  previous: string | null;
  next: string | null;
};

/**
 * Previous / Page N / Next under a long list. Previous and Next keep their places at
 * the two edges whichever exists, so someone paging through clicks the same spot each
 * time. Nothing renders when the list fits on one page.
 */
export function Pager({ label, links }: { label: string; links: PagerLinks }) {
  if (!links.previous && !links.next) return null;
  return (
    <nav aria-label={label} className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 text-sm">
      <div>
        {links.previous && (
          <Link href={links.previous} rel="prev" className={outlineButton}>
            ← Previous
          </Link>
        )}
      </div>
      <p className="text-muted tabular-nums">
        Page {links.number}
        {links.first && (
          <>
            <span aria-hidden> · </span>
            <Link href={links.first} className={quietLink}>
              First page
            </Link>
          </>
        )}
      </p>
      <div className="justify-self-end">
        {links.next && (
          <Link href={links.next} rel="next" className={outlineButton}>
            Next →
          </Link>
        )}
      </div>
    </nav>
  );
}
