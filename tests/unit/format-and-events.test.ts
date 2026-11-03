import assert from "node:assert/strict";
import { test } from "node:test";
import { byUser } from "@/domain/change-source";
import { LEAVE_EVENT_TYPES, leaveAuditAction, leaveEventPayload } from "@/domain/events";
import { todayInTimeZone } from "@/lib/dates";
import { formatDays, formatLeaveDates } from "@/lib/format";

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

test("the year-end note lists what won't carry over", async () => {
  const { formatExpiring } = await import("@/lib/format");
  assert.equal(formatExpiring([{ name: "PTO", days: 6 }], 2027), "6 days of PTO won’t carry into 2027.");
  assert.equal(
    formatExpiring(
      [
        { name: "PTO", days: 1 },
        { name: "Sick", days: 2.5 },
      ],
      2027,
    ),
    "1 day of PTO and 2.5 days of Sick won’t carry into 2027.",
  );
});
