import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCalendarChange, sameSplit } from "@/domain/leave-days";
import { formatNoWorkingDays, formatRecountCause, formatRecountOutcome } from "@/lib/format";
import { renderLeaveEmail } from "@/server/email/leave-emails";

test("a calendar change moves each open year by its own difference, and leaves closed years alone", () => {
  // Dec 29, 2025 to Jan 2, 2026 stored as 3 + 2; Jan 1, 2026 becomes a holiday.
  const stored = [
    { year: 2025, days: 3 },
    { year: 2026, days: 2 },
  ];
  const before = stored;
  const after = [
    { year: 2025, days: 3 },
    { year: 2026, days: 1 },
  ];
  assert.deepEqual(applyCalendarChange(stored, before, after, 2026), after);
  assert.deepEqual(
    applyCalendarChange(
      stored,
      before,
      [
        { year: 2025, days: 2 },
        { year: 2026, days: 2 },
      ],
      2026,
    ),
    stored,
    "a change in a closed year moves nothing",
  );
});

test("only the change's own difference is applied, so an earlier correction survives", () => {
  // Stored 3 days though today's calendar, before this change, counts 5 (a past adjustment, or
  // holidays deleted before recounting existed). Adding one holiday takes exactly one day off.
  const stored = [{ year: 2026, days: 3 }];
  assert.deepEqual(applyCalendarChange(stored, [{ year: 2026, days: 5 }], [{ year: 2026, days: 4 }], 2026), [{ year: 2026, days: 2 }]);
  assert.deepEqual(applyCalendarChange(stored, [{ year: 2026, days: 5 }], [{ year: 2026, days: 6 }], 2026), [{ year: 2026, days: 4 }]);
});

test("a request now entirely on non-working days costs nothing; undoing the change restores it", () => {
  const halfDay = [{ year: 2026, days: 0.5 }];
  const free = applyCalendarChange(halfDay, halfDay, [], 2026);
  assert.deepEqual(free, [], "no rows: it costs 0 days");
  assert.deepEqual(applyCalendarChange(free, [], halfDay, 2026), halfDay, "deleting the holiday again gives the half day back");
  assert.deepEqual(applyCalendarChange([{ year: 2026, days: 1 }], [{ year: 2026, days: 3 }], [], 2026), [], "never negative");
});

test("a move between years is applied per year, ordered by year", () => {
  assert.deepEqual(
    applyCalendarChange(
      [
        { year: 2026, days: 1 },
        { year: 2027, days: 1 },
      ],
      [
        { year: 2026, days: 1 },
        { year: 2027, days: 1 },
      ],
      [{ year: 2027, days: 2 }],
      2026,
    ),
    [{ year: 2027, days: 2 }],
  );
});

test("splits compare by year and days", () => {
  assert.equal(sameSplit([{ year: 2026, days: 2 }], [{ year: 2026, days: 2 }]), true);
  assert.equal(sameSplit([{ year: 2026, days: 2 }], [{ year: 2026, days: 1.5 }]), false);
  assert.equal(
    sameSplit(
      [{ year: 2026, days: 2 }],
      [
        { year: 2026, days: 2 },
        { year: 2027, days: 1 },
      ],
    ),
    false,
  );
  assert.equal(sameSplit([], []), true);
});

test("the recount cause names a single holiday, several, or the working days", () => {
  const xmas = { date: "2026-12-25", name: "Christmas Day" };
  const eve = { date: "2026-12-24", name: "Christmas Eve" };
  assert.equal(
    formatRecountCause({ kind: "holidays", added: [xmas], removed: [] }),
    "Fri, Dec 25, 2026 is now a company holiday (Christmas Day)",
  );
  assert.equal(formatRecountCause({ kind: "holidays", added: [], removed: [xmas] }), "Fri, Dec 25, 2026 is no longer a company holiday");
  assert.equal(
    formatRecountCause({ kind: "holidays", added: [eve, xmas], removed: [] }),
    "Christmas Eve, Christmas Day are now company holidays",
  );
  assert.equal(
    formatRecountCause({ kind: "holidays", added: [eve], removed: [xmas] }),
    "The company holidays during your time off changed",
  );
  assert.equal(formatRecountCause({ kind: "working_days" }), "The company's working days changed");
});

test("a request with no working days names the holiday it fell on", () => {
  assert.equal(
    formatNoWorkingDays([{ date: "2026-12-25", name: "Christmas Day" }]),
    "Fri, Dec 25, 2026 is Christmas Day, a company holiday, so there's nothing to request.",
  );
  assert.equal(
    formatNoWorkingDays([
      { date: "2026-12-24", name: "Christmas Eve" },
      { date: "2026-12-25", name: "Christmas Day" },
    ]),
    "Those dates are days off or company holidays (Christmas Eve, Christmas Day), so there's nothing to request.",
  );
  assert.equal(formatNoWorkingDays([]), "Those dates are all weekends or days off, so there's nothing to request.");
});

test("the admin's confirmation says what the recount changed, and who is over", () => {
  assert.equal(formatRecountOutcome({ recounted: 0, nowFree: 0, overdrawn: [] }), "");
  assert.equal(formatRecountOutcome({ recounted: 1, nowFree: 0, overdrawn: [] }), "1 request was recounted.");
  assert.equal(
    formatRecountOutcome({
      recounted: 2,
      nowFree: 1,
      overdrawn: [{ personName: "Ana Test", leaveTypeName: "PTO", year: 2026, over: 1 }],
    }),
    "2 requests were recounted; 1 now takes no days. Ana Test is now 1 day over on PTO for 2026.",
  );
});

const leave = {
  requesterName: "Ana",
  leaveTypeName: "PTO",
  startDate: "2026-12-21",
  endDate: "2026-12-25",
  dayPortion: "full" as const,
  days: 4,
  note: null,
};

test("the recount email says why and what changed, including when nothing is taken any more", () => {
  const cause = { kind: "holidays" as const, added: [{ date: "2026-12-25", name: "Christmas Day" }], removed: [] };
  const base = { kind: "recounted" as const, recipientName: "Ana", cause, overdrawn: null, link: "https://ooohm.test/" };
  const recounted = renderLeaveEmail({ ...base, leave, previousDays: 5 });
  assert.equal(recounted.subject, "Your time off was recounted");
  assert.match(
    recounted.text,
    /Fri, Dec 25, 2026 is now a company holiday \(Christmas Day\), so the time off below now takes 4 days instead of 5 days\./,
  );
  assert.doesNotMatch(recounted.text, /Balance:/);

  const over = renderLeaveEmail({ ...base, leave, previousDays: 3, overdrawn: "1 day over your PTO balance for 2026" });
  assert.match(over.text, /Balance: This leaves you 1 day over your PTO balance for 2026\./);

  const free = renderLeaveEmail({ ...base, leave: { ...leave, startDate: "2026-12-25", endDate: "2026-12-25", days: 0 }, previousDays: 1 });
  assert.equal(free.subject, "Your time off was recounted");
  assert.match(
    free.text,
    /no longer takes any days, and nothing comes off your balance\. You can cancel it in OOOhm if you don't need it\./,
  );

  const tricky = renderLeaveEmail({
    ...base,
    leave,
    previousDays: 5,
    cause: { kind: "holidays", added: [{ date: "2026-12-25", name: "<b>Xmas</b>" }], removed: [] },
  });
  assert.ok(tricky.html.includes("&lt;b&gt;Xmas&lt;/b&gt;") && !tricky.html.includes("<b>Xmas"), "holiday names are escaped in HTML");
  assert.ok(!tricky.subject.includes("Xmas"), "and never reach the subject");
});

test("the request email to an approver carries the who-else-is-off line, when there is one", () => {
  const withHint = renderLeaveEmail({
    kind: "requested",
    recipientName: "Boss",
    leave,
    alsoOff: "Vera is off then too.",
    link: "https://ooohm.test/approvals",
  });
  assert.match(withHint.text, /^Who else is off: Vera is off then too\.$/m);
  const without = renderLeaveEmail({
    kind: "requested",
    recipientName: "Boss",
    leave,
    alsoOff: null,
    link: "https://ooohm.test/approvals",
  });
  assert.doesNotMatch(without.text, /Who else is off/);
});
