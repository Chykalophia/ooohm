/**
 * The calendar year at `now` in the company's timezone. Allowance years follow the
 * company's calendar, not the server's clock: at 20:00 on Dec 31 in Chicago a UTC
 * server is already in the next year.
 */
export function yearInTimeZone(timeZone: string, now: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(now));
}
