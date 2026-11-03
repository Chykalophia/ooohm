import assert from "node:assert/strict";
import { test } from "node:test";
import { showsPreview } from "@/app/request-preview";
import { type FormState, IDLE, nextFormKey } from "@/components/forms/form-state";

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

test("after a successful submit the preview stays hidden until the draft changes", () => {
  const defaults = { leaveTypeId: "pto", startDate: "2026-11-02", endDate: "2026-11-02", dayPortion: "full" };
  assert.equal(showsPreview(false, defaults, defaults), true, "before any submit, the default draft is previewed");
  assert.equal(showsPreview(true, defaults, defaults), false, "the reset form is not described as if it were the request just sent");
  assert.equal(showsPreview(true, { ...defaults, endDate: "2026-11-06" }, defaults), true, "a new date brings it back");
  assert.equal(showsPreview(true, { ...defaults, leaveTypeId: "sick" }, defaults), true, "so does another type");
  assert.equal(showsPreview(true, { ...defaults, dayPortion: "am" }, defaults), true, "or a half day");
});
