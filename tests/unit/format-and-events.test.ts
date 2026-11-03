import assert from "node:assert/strict";
import { test } from "node:test";
import { byUser } from "@/domain/change-source";
import { LEAVE_EVENT_TYPES, leaveAuditAction, leaveEventPayload } from "@/domain/events";
import { todayInTimeZone } from "@/lib/dates";
import {
  formatDays,
  formatInstantDate,
  formatInstantDateTime,
  formatInstantFull,
  formatInstantShort,
  formatLeaveDates,
} from "@/lib/format";

test("formats single days, ranges, cross-year ranges and half days", () => {
  assert.equal(formatLeaveDates("2026-11-02", "2026-11-02"), "Mon, Nov 2, 2026");
  assert.equal(formatLeaveDates("2026-11-02", "2026-11-06"), "Mon, Nov 2 to Fri, Nov 6, 2026");
  assert.equal(formatLeaveDates("2026-12-31", "2027-01-04"), "Thu, Dec 31, 2026 to Mon, Jan 4, 2027");
  assert.equal(formatLeaveDates("2026-11-02", "2026-11-02", "am"), "Mon, Nov 2, 2026 (morning)");
});

test("formatted dates do not move with the process time zone", () => {
  const original = process.env.TZ;
  try {
    for (const tz of ["Pacific/Pago_Pago", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      assert.equal(formatLeaveDates("2026-03-08", "2026-03-08"), "Sun, Mar 8, 2026", tz);
    }
  } finally {
    process.env.TZ = original;
  }
});

test("day counts read naturally", () => {
  assert.equal(formatDays(1), "1 day");
  assert.equal(formatDays(0.5), "0.5 days");
  assert.equal(formatDays(3), "3 days");
});

test("today follows the company's time zone, not the server's", () => {
  const instant = new Date("2026-11-02T03:00:00Z");
  assert.equal(todayInTimeZone("America/Chicago", instant), "2026-11-01");
  assert.equal(todayInTimeZone("UTC", instant), "2026-11-02");
  assert.equal(todayInTimeZone("Asia/Tokyo", new Date("2026-12-31T15:00:00Z")), "2027-01-01");
});

test("event names and payload shape are the public contract", () => {
  assert.deepEqual(Object.values(LEAVE_EVENT_TYPES), ["leave.requested", "leave.approved", "leave.rejected", "leave.cancelled"]);
  assert.equal(leaveAuditAction("approved"), "leave_request.approved");
  const payload = leaveEventPayload(
    {
      id: "r1",
      userId: "u1",
      leaveTypeId: "t1",
      startDate: "2026-11-02",
      endDate: "2026-11-02",
      dayPortion: "am",
      days: 0.5,
      status: "pending",
    },
    byUser("u1"),
  );
  assert.deepEqual(payload, {
    requestId: "r1",
    userId: "u1",
    leaveTypeId: "t1",
    startDate: "2026-11-02",
    endDate: "2026-11-02",
    dayPortion: "am",
    days: 0.5,
    status: "pending",
    actorId: "u1",
    actor: { type: "user", id: "u1" },
  });
});

test("table times: the year only when it differs from now's in the company's zone, and the full record to the second", () => {
  const tz = "America/Chicago";
  const now = new Date("2026-11-02T18:00:00Z");
  assert.equal(formatInstantShort(new Date("2026-11-02T16:42:00Z"), tz, now), "Nov 2, 10:42 AM");
  assert.equal(formatInstantShort(new Date("2025-12-30T22:05:00Z"), tz, now), "Dec 30, 2025, 4:05 PM");
  // 03:00 UTC on New Year's Day is still Dec 31, 2025 in Chicago; now is already 2026 there.
  assert.equal(formatInstantShort(new Date("2026-01-01T03:00:00Z"), tz, new Date("2026-01-01T12:00:00Z")), "Dec 31, 2025, 9:00 PM");
  assert.equal(formatInstantFull(new Date("2026-11-02T16:42:07Z"), tz), "Nov 2, 2026, 10:42:07 AM CST");
  assert.equal(formatInstantDateTime(new Date("2026-11-02T16:42:07Z"), tz), "Nov 2, 2026, 10:42 AM CST");
  assert.equal(formatInstantDate(new Date("2026-11-02T16:42:07Z"), "Asia/Tokyo"), "Nov 3, 2026", "each zone its own formatter");
});
