import assert from "node:assert/strict";
import { test } from "node:test";
import { coverageBreach, describeCoverageBreach } from "@/domain/coverage";
import { formatShortDay } from "@/lib/format";

// Mon 2026-03-02 .. Fri 2026-03-06; weekends are 03-07 and 03-08.
const WEEK = { workingDays: [1, 2, 3, 4, 5], holidays: [] };
const off = (userId: string, startDate: string, endDate = startDate, departmentId: string | null = "design") => ({ userId, departmentId, startDate, endDate });
const target = (startDate: string, endDate = startDate, maxOff = 2) => ({ requesterId: "me", departmentId: "design", startDate, endDate, maxOff });

test("within the limit there's no warning; the requester counts as one of those off", () => {
  assert.equal(coverageBreach(target("2026-03-03"), [off("ana", "2026-03-03")], WEEK), null, "2 of a limit of 2");
  assert.deepEqual(coverageBreach(target("2026-03-03"), [off("ana", "2026-03-03"), off("bo", "2026-03-02", "2026-03-04")], WEEK), {
    peak: 3,
    firstDate: "2026-03-03",
    days: 1,
    maxOff: 2,
  });
});

test("only the requester's department counts, each person once a day, and never the requester's own other leave", () => {
  const leave = [
    off("ana", "2026-03-03"),
    off("ana", "2026-03-03"),
    off("cy", "2026-03-03", "2026-03-03", "sales"),
    off("dee", "2026-03-03", "2026-03-03", null),
    off("me", "2026-03-03"),
  ];
  assert.equal(coverageBreach(target("2026-03-03"), leave, WEEK), null);
});

test("weekends and holidays never count", () => {
  const leave = [off("ana", "2026-03-06", "2026-03-09"), off("bo", "2026-03-06", "2026-03-09")];
  // Fri over the limit, the weekend skipped, Mon a holiday.
  const breach = coverageBreach(target("2026-03-06", "2026-03-09"), leave, { ...WEEK, holidays: [{ date: "2026-03-09" }] });
  assert.deepEqual(breach, { peak: 3, firstDate: "2026-03-06", days: 1, maxOff: 2 });
});

test("over several days it reports the first day, how many days and the most at once", () => {
  const leave = [off("ana", "2026-03-03", "2026-03-05"), off("bo", "2026-03-04"), off("cy", "2026-03-04")];
  const breach = coverageBreach(target("2026-03-02", "2026-03-06", 1), leave, WEEK);
  assert.deepEqual(breach, { peak: 4, firstDate: "2026-03-03", days: 3, maxOff: 1 });
});

test("the warning reads the same for the requester and the approver, and says so when it's already booked", () => {
  const one = { peak: 3, firstDate: "2026-03-03", days: 1, maxOff: 2 };
  assert.equal(describeCoverageBreach(one, "Design", formatShortDay), "This would put 3 people in Design off on Tue, Mar 3. The limit is 2.");
  assert.equal(describeCoverageBreach(one, "Design", formatShortDay, true), "This puts 3 people in Design off on Tue, Mar 3. The limit is 2.");
  assert.equal(
    describeCoverageBreach({ ...one, peak: 4, days: 3 }, "Design", formatShortDay),
    "This would put up to 4 people in Design off at once, on 3 days from Tue, Mar 3. The limit is 2.",
  );
});
