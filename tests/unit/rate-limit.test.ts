import assert from "node:assert/strict";
import { test } from "node:test";
import { createRateLimiter } from "@/lib/rate-limit";

test("allows `limit` hits per key per window, refuses the next, and starts over in the next window", () => {
  let clock = 0;
  const limiter = createRateLimiter({ limit: 3, windowMs: 1000, now: () => clock });

  assert.deepEqual([1, 2, 3, 4].map(() => limiter.take("ana")), [true, true, true, false]);
  assert.equal(limiter.take("bo"), true, "each key has its own budget");

  clock = 999;
  assert.equal(limiter.take("ana"), false, "still the same window");
  clock = 1000;
  assert.deepEqual([1, 2, 3, 4].map(() => limiter.take("ana")), [true, true, true, false]);
});

test("sweeping expired windows never resets a live one", () => {
  let clock = 0;
  const limiter = createRateLimiter({ limit: 1, windowMs: 10, now: () => clock });
  for (let i = 0; i < 50; i++) limiter.take(`old${i}`);
  clock = 6;
  assert.equal(limiter.take("live"), true);
  clock = 12; // past the old windows, inside live's: the sweep runs here
  assert.equal(limiter.take("live"), false);
  assert.equal(limiter.take("old0"), true, "an expired key starts a fresh window");
});

test("10k distinct keys in one window never hold more than the cap, and the newest keys keep their counts", () => {
  let clock = 0;
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 100, now: () => clock });
  for (let i = 0; i < 10_000; i++) {
    clock = i; // all inside one window
    assert.equal(limiter.take(`k${i}`), true);
    assert.ok(limiter.size <= 100, `size ${limiter.size} at ${i}`);
  }
  assert.equal(limiter.size, 100);
  assert.equal(limiter.take("k9999"), false, "a recent key is still at its limit");
  assert.equal(limiter.take("k0"), true, "the oldest key was dropped, so it starts over");
});

test("the default cap bounds a limiter built without one", () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
  for (let i = 0; i < 10_050; i++) limiter.take(`k${i}`);
  assert.equal(limiter.size, 10_000);
});

test("a renewed key's window is not swept early by keys that started after its first window", () => {
  let clock = 0;
  const limiter = createRateLimiter({ limit: 1, windowMs: 10, now: () => clock });
  limiter.take("a");
  clock = 5;
  limiter.take("b");
  clock = 10;
  assert.equal(limiter.take("a"), true, "a's first window is over");
  clock = 15; // b has expired; a's renewed window (from 10) is live
  assert.equal(limiter.take("a"), false);
  assert.equal(limiter.take("b"), true);
});
