import type { YearDays } from "@/shared/kernel/leave-days";

/**
 * A submitted request's per-year split after the calendar changed, applying only what
 * the change itself made different: each open year (`firstOpenYear` and later) moves by
 * what the request counts with the new calendar minus what it counted with the old one,
 * and years before `firstOpenYear` keep what `stored` charged them (their balances are
 * settled and carried over). Applying the difference, rather than recounting from
 * scratch, leaves any earlier adjustment to the stored split alone. Ordered by year;
 * years left with no days are dropped, so every entry has `days > 0`, and an empty
 * result means the request now costs nothing.
 *
 * Known limit: a year never goes below 0, and what would have taken it below is not
 * kept. That only happens when the stored split already counted fewer days than the
 * calendar (an imported split, or one stored before recounts existed): taking such a year
 * to 0 and then undoing the change restores the calendar's count, not the smaller stored
 * one. Remembering it would need a per-year offset stored with the request.
 *
 * @param stored The split saved with the request.
 * @param before The split counted with the calendar before the change.
 * @param after The split counted with the calendar after the change.
 */
export function applyCalendarChange(
  stored: readonly YearDays[],
  before: readonly YearDays[],
  after: readonly YearDays[],
  firstOpenYear: number,
): YearDays[] {
  const daysIn = (split: readonly YearDays[], year: number) => split.find((y) => y.year === year)?.days ?? 0;
  const years = [...new Set([...stored, ...before, ...after].map((y) => y.year))].sort((a, b) => a - b);
  return years
    .map((year) => {
      const kept = daysIn(stored, year);
      if (year < firstOpenYear) return { year, days: kept };
      const moved = Math.round((kept + daysIn(after, year) - daysIn(before, year)) * 10) / 10;
      return { year, days: Math.max(0, moved) };
    })
    .filter((y) => y.days > 0);
}

/** Whether two per-year splits charge the same days to the same years. */
export function sameSplit(a: readonly YearDays[], b: readonly YearDays[]): boolean {
  return a.length === b.length && a.every((y, i) => y.year === b[i]?.year && y.days === b[i]?.days);
}
