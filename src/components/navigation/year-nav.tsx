import Link from "next/link";
import { outlineButton } from "@/components/ui/styles";

/**
 * Previous / current / next year, for admin pages that show one year at a time. A
 * neighbour outside `[min, max]` gets no link, so the page never jumps somewhere the
 * page's own year parsing would refuse.
 */
export function YearNav({ year, min, max, href }: { year: number; min: number; max: number; href: (year: number) => string }) {
  return (
    <nav aria-label="Year" className="flex items-center gap-4">
      {year > min && (
        <Link href={href(year - 1)} className={outlineButton} aria-label={`Previous year, ${year - 1}`}>
          ← {year - 1}
        </Link>
      )}
      <h2 className="text-lg font-semibold tabular-nums">{year}</h2>
      {year < max && (
        <Link href={href(year + 1)} className={outlineButton} aria-label={`Next year, ${year + 1}`}>
          {year + 1} →
        </Link>
      )}
    </nav>
  );
}
