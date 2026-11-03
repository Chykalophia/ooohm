import assert from "node:assert/strict";
import { test } from "node:test";
import { moveTo, sameOrder, slotFor } from "@/components/ui/sortable-order";

test("moving an item puts it at the new place and keeps the others in order", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(moveTo(ids, "d", 0), ["d", "a", "b", "c"], "to the top");
  assert.deepEqual(moveTo(ids, "a", 3), ["b", "c", "d", "a"], "to the bottom");
  assert.deepEqual(moveTo(ids, "b", 2), ["a", "c", "b", "d"], "one down");
  assert.deepEqual(moveTo(ids, "c", 2), ids, "where it is");
  assert.deepEqual(moveTo(ids, "a", -1), ids, "before the top stays first");
  assert.deepEqual(moveTo(ids, "a", 99), ["b", "c", "d", "a"], "past the end goes last");
  assert.deepEqual(moveTo(ids, "x", 0), ids, "an unknown id changes nothing");
  assert.notEqual(moveTo(ids, "c", 2), ids, "always a new list");
});

test("a dragged item takes a neighbour's place once its middle passes the neighbour's middle", () => {
  // The others' middles, top to bottom, with the dragged item lifted out.
  const middles = [20, 60, 100];
  assert.equal(slotFor(5, middles), 0, "above the first: first");
  assert.equal(slotFor(19, middles), 0, "not yet past the first's middle");
  assert.equal(slotFor(21, middles), 1, "just past it: after it");
  assert.equal(slotFor(60, middles), 1, "exactly on a middle does not pass it, so it does not flicker");
  assert.equal(slotFor(500, middles), 3, "below them all: last");
  assert.equal(slotFor(10, []), 0, "alone: stays first");
});

test("orders compare by ids and position", () => {
  assert.ok(sameOrder(["a", "b"], ["a", "b"]));
  assert.ok(!sameOrder(["a", "b"], ["b", "a"]));
  assert.ok(!sameOrder(["a"], ["a", "b"]));
});
