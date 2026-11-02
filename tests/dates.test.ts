import assert from "node:assert/strict";
import { test } from "node:test";
import { yearInTimeZone } from "../src/lib/dates.ts";

// 2026-12-31 20:00 in Chicago (CST, UTC-6) is 2027-01-01 02:00 UTC.
const newYearsEveChicago = new Date("2027-01-01T02:00:00Z");

test("uses the company's year, not the server's, across New Year", () => {
  assert.equal(yearInTimeZone("America/Chicago", newYearsEveChicago), 2026);
  assert.equal(yearInTimeZone("UTC", newYearsEveChicago), 2027);
});

test("rolls over at local midnight", () => {
  assert.equal(yearInTimeZone("America/Chicago", new Date("2027-01-01T05:59:59Z")), 2026);
  assert.equal(yearInTimeZone("America/Chicago", new Date("2027-01-01T06:00:00Z")), 2027);
});

test("east of UTC rolls over before the server does", () => {
  assert.equal(yearInTimeZone("Asia/Tokyo", new Date("2026-12-31T15:00:00Z")), 2027);
});
