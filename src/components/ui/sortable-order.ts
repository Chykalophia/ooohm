/**
 * The arithmetic of {@link SortableList}, kept apart from the DOM so it can be tested:
 * where an item lands while it is dragged, and moving it there.
 */

/** `ids` with `id` moved to `to` (clamped to the list), the others keeping their order. */
export function moveTo(ids: readonly string[], id: string, to: number): string[] {
  const from = ids.indexOf(id);
  if (from === -1) return [...ids];
  const rest = ids.filter((x) => x !== id);
  const at = Math.max(0, Math.min(rest.length, to));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/**
 * Where a dragged item belongs, given where its middle is now and the middles of the
 * other items (top to bottom): after every other item whose middle it has passed. So it
 * swaps with a neighbour once it covers half of it, in either direction, and never
 * jumps back and forth at a boundary.
 */
export function slotFor(draggedMiddle: number, otherMiddles: readonly number[]): number {
  return otherMiddles.filter((middle) => draggedMiddle > middle).length;
}

/** Whether two orders are the same. */
export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
