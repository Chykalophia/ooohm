import Link from "next/link";
import { outlineButton, subtleButton } from "./styles";

/**
 * A search form that filters the list below it through the page's query string, so a
 * filtered view can be bookmarked and Back works. Its fields are the children; Filter
 * and Clear (shown once something is filtered) follow them.
 *
 * @param className The layout of the fields (a wrapping row, a grid).
 */
export function FilterBar({
  label,
  clearHref,
  filtered,
  className,
  children,
}: {
  label: string;
  clearHref: string;
  filtered: boolean;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <form method="get" role="search" aria-label={label} className={className}>
      {children}
      <div className="flex items-center gap-4 self-end">
        <button type="submit" className={outlineButton}>
          Filter
        </button>
        {filtered && (
          <Link href={clearHref} className={subtleButton}>
            Clear
          </Link>
        )}
      </div>
    </form>
  );
}
