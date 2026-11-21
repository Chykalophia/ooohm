/**
 * Narrowing helpers for tests. Each one asserts what the test relies on (a row exists, a
 * value is set) and returns it typed, so a missing value fails with a clear message
 * instead of a TypeError further down.
 */
import assert from "node:assert/strict";

/** `value`, failing when it is null or undefined. */
export function present<T>(value: T | null | undefined, what = "value"): T {
  assert.ok(value !== undefined && value !== null, `expected ${what} to be present, got ${String(value)}`);
  return value;
}

/** The first of `rows`, failing when there are none. */
export function first<T>(rows: readonly T[], what = "row"): T {
  return at(rows, 0, what);
}

/** The entry at `index` of `rows` (negative counts from the end), failing when there is none. */
export function at<T>(rows: readonly T[], index: number, what = "row"): T {
  const row = rows.at(index);
  assert.ok(row !== undefined, `expected a ${what} at index ${index}, got ${rows.length} in all`);
  return row;
}

type Tuple<T, N extends number, Acc extends T[] = []> = Acc["length"] extends N ? Acc : Tuple<T, N, [...Acc, T]>;

/** The first `count` of `rows` as a tuple, for `const [a, b] = take(rows, 2)`; fails when there are fewer. */
export function take<T, N extends number>(rows: readonly T[], count: N): Tuple<T, N> {
  assert.ok(rows.length >= count, `expected at least ${count} rows, got ${rows.length}`);
  return rows.slice(0, count) as Tuple<T, N>;
}
