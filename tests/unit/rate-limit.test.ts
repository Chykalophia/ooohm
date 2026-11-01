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
