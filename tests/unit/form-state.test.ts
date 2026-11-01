import assert from "node:assert/strict";
import { test } from "node:test";
import { type FormState, IDLE, nextFormKey } from "@/app/form-state";

const success = (id: string): FormState => ({ status: "success", message: "Sent", id });
const failure: FormState = { status: "error", message: "You already have time off on some of those dates." };

/** Folds a sequence of action results into the keys the form renders with. */
function keysFor(states: FormState[]): string[] {
  const keys: string[] = [];
  let current = "form";
  for (const state of states) {
    current = nextFormKey(current, state);
    keys.push(current);
  }
  return keys;
}

test("an error keeps the fields mounted, before and after an earlier success", () => {
  assert.deepEqual(keysFor([IDLE, failure]), ["form", "form"]);
  assert.deepEqual(keysFor([IDLE, success("a"), failure, failure]), ["form", "a", "a", "a"]);
});

test("each new success clears the fields, including one after an error", () => {
  assert.deepEqual(keysFor([success("a"), failure, success("b")]), ["a", "a", "b"]);
  // Re-rendering with the same success does not clear the fields again.
  assert.deepEqual(keysFor([success("a"), success("a")]), ["a", "a"]);
});
