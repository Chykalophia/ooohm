import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { deletionStep, hasScheduledScrub, isScrubDue, isScrubWaiting } from "@/modules/people/domain/deletion-lifecycle";
import { DELETION_GRACE_DAYS, scrubDueAt } from "@/modules/people/domain/person-deletion";

/**
 * Every transition of a delete: request → (run now | schedule → grace → scrub), with undo
 * while it waits and a hold when a rule refuses it once due.
 */
const NOW = new Date("2026-03-02T10:00:00Z");
const DAY = 86_400_000;
const later = new Date(NOW.getTime() + DAY);
const earlier = new Date(NOW.getTime() - DAY);

describe("asking for a delete", () => {
  test("keeping records runs at once, with or without the grace option", () => {
    for (const deletionGrace of [false, true]) {
      assert.deepEqual(deletionStep({ mode: "records_kept", deletionGrace, scrubScheduledAt: null, now: NOW }), { kind: "delete_now", mode: "records_kept" });
    }
  });

  test("keeping records replaces a scrub that was scheduled", () => {
    assert.deepEqual(deletionStep({ mode: "records_kept", deletionGrace: true, scrubScheduledAt: later, now: NOW }), { kind: "delete_now", mode: "records_kept" });
  });

  test("a full scrub without the grace option runs at once", () => {
    assert.deepEqual(deletionStep({ mode: "scrubbed", deletionGrace: false, scrubScheduledAt: null, now: NOW }), { kind: "delete_now", mode: "scrubbed" });
  });

  test("a full scrub with the grace option is scheduled DELETION_GRACE_DAYS ahead", () => {
    const step = deletionStep({ mode: "scrubbed", deletionGrace: true, scrubScheduledAt: null, now: NOW });
    assert.deepEqual(step, { kind: "schedule", scheduledFor: scrubDueAt(NOW) });
    assert.equal(scrubDueAt(NOW).getTime() - NOW.getTime(), DELETION_GRACE_DAYS * DAY);
  });

  test("asking again while a scrub waits keeps the date it has", () => {
    assert.deepEqual(deletionStep({ mode: "scrubbed", deletionGrace: true, scrubScheduledAt: later, now: NOW }), { kind: "already_scheduled", scheduledFor: later });
  });
});

describe("the grace period", () => {
  test("nothing scheduled is never due", () => {
    assert.equal(isScrubDue(null, NOW), false);
  });

  test("a scrub is due from its date on, not before", () => {
    assert.equal(isScrubDue(later, NOW), false);
    assert.equal(isScrubDue(NOW, NOW), true);
    assert.equal(isScrubDue(earlier, NOW), true);
  });

  test("a due scrub a rule refuses waits; one not yet due never shows as waiting", () => {
    assert.equal(isScrubWaiting(earlier, NOW, true), true);
    assert.equal(isScrubWaiting(earlier, NOW, false), false);
    assert.equal(isScrubWaiting(later, NOW, true), false);
    assert.equal(isScrubWaiting(null, NOW, true), false);
  });
});

describe("undo", () => {
  test("only a scheduled scrub has anything to cancel", () => {
    assert.equal(hasScheduledScrub({ scrubScheduledAt: later }), true);
    assert.equal(hasScheduledScrub({ scrubScheduledAt: null }), false);
  });
});
