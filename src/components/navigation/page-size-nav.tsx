import Link from "next/link";
import { cx, focusRing } from "@/components/ui/styles";

/**
 * "Rows 25 · 50 · 100" for a long table: plain links, so it works without JavaScript and
 * the choice stays in the URL. The current size is marked, not linked.
 *
 * @param href The list at `size` rows a page, from page 1 (a cursor belongs to one size).
 */
export function PageSizeNav({ sizes, current, href }: { sizes: readonly number[]; current: number; href: (size: number) => string }) {
  return (
    <nav aria-label="Rows per page" className="flex items-center gap-1 text-sm text-muted">
      <span className="mr-1">Rows</span>
      {sizes.map((size) =>
        size === current ? (
          <span
            key={size}
            aria-current="true"
            className="rounded-md border border-border bg-surface px-2 py-0.5 text-foreground tabular-nums"
          >
            {size}
          </span>
        ) : (
          <Link
            key={size}
            href={href(size)}
            className={cx("rounded-md border border-transparent px-2 py-0.5 tabular-nums hover:text-foreground", focusRing)}
          >
            {size}
          </Link>
        ),
      )}
    </nav>
  );
}
