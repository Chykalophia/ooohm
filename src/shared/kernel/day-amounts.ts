/**
 * Adds day amounts in tenths, so 0.1 + 0.2 is 0.3. Every stored amount is
 * `numeric(5,1)`, so tenths are exact.
 */
export function addDays(...amounts: number[]): number {
  return amounts.reduce((sum, n) => sum + Math.round(n * 10), 0) / 10;
}
