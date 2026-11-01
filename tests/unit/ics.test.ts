import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CalendarEntry, TeamCalendarEntry } from "@/domain/calendar";
import { buildFeedCalendar, feedEventSummary, feedEventUid, feedWindow } from "@/domain/calendar-feed";
import {
  escapeIcsText,
  exclusiveEndDate,
  foldIcsLine,
  type IcsCalendar,
  type IcsEvent,
  serializeCalendar,
} from "@/domain/ics";
import { only, parseIcs, unescapeText } from "../support/ics-parser";

const generatedAt = new Date("2026-11-01T15:04:05.678Z");

function event(overrides: Partial<IcsEvent> = {}): IcsEvent {
  return {
    uid: "4b0d6a0e-3c0b-4b8a-9d55-0d1c7a1f2e3b@ooohm",
    startDate: "2026-11-02",
    endDate: "2026-11-02",
    summary: "PTO",
    status: "CONFIRMED",
    transparency: "OPAQUE",
    ...overrides,
  };
}

function calendar(events: IcsEvent[], name = "OOOhm: My time off"): IcsCalendar {
  return { name, refreshInterval: "PT1H", generatedAt, events };
}

describe("TEXT escaping", () => {
  test("backslash, semicolon, comma and every kind of line break are escaped", () => {
    assert.equal(escapeIcsText("a\\b;c,d"), "a\\\\b\\;c\\,d");
    assert.equal(escapeIcsText("one\ntwo\r\nthree\rfour"), "one\\ntwo\\nthree\\nfour");
    // Backslashes are escaped first, so an escape sequence in the input stays literal.
    assert.equal(escapeIcsText("\\n"), "\\\\n");
    assert.equal(unescapeText(escapeIcsText("Ana, Ben; Co\\Op\nline")), "Ana, Ben; Co\\Op\nline");
  });

  test("control characters TEXT may not hold are dropped; tab and Unicode stay", () => {
    assert.equal(escapeIcsText("a\u0000b\u0007c\u001bd\u007fe"), "abcde");
    assert.equal(escapeIcsText("a\tb"), "a\tb");
    assert.equal(escapeIcsText("Zoë 😀 東京"), "Zoë 😀 東京");
  });
});

describe("line folding", () => {
  test("a line of exactly 75 octets stays whole; 76 folds", () => {
    const exact = "X".repeat(75);
    assert.equal(foldIcsLine(exact), exact);
    assert.equal(foldIcsLine("X".repeat(76)), `${"X".repeat(75)}\r\n X`);
  });

  test("long ASCII lines fold into 75-octet lines that unfold to the original", () => {
    const line = `SUMMARY:${"abcdefghij".repeat(30)}`;
    const folded = foldIcsLine(line).split("\r\n");
    assert.ok(folded.length > 1);
    for (const [i, part] of folded.entries()) {
      assert.ok(Buffer.byteLength(part) <= 75);
      if (i > 0) assert.ok(part.startsWith(" "), "continuation lines start with a space");
    }
    assert.equal(folded[0].length, 75, "the first line is filled to the limit");
    assert.equal(folded.map((p, i) => (i === 0 ? p : p.slice(1))).join(""), line);
  });

  test("multibyte characters are never split, whatever their width", () => {
    for (const char of ["é", "東", "😀", "👩‍👩‍👧"]) {
      for (let pad = 0; pad < 4; pad++) {
        const line = `SUMMARY:${"a".repeat(pad)}${char.repeat(40)}`;
        const parts = foldIcsLine(line).split("\r\n");
        for (const part of parts) {
          assert.ok(Buffer.byteLength(part, "utf8") <= 75, `${char} pad ${pad}: ${Buffer.byteLength(part, "utf8")} octets`);
          assert.ok(part.isWellFormed(), `${char} pad ${pad}: no lone surrogate`);
          // Round-trips through UTF-8 bytes unchanged: no character was cut.
          assert.equal(Buffer.from(part, "utf8").toString("utf8"), part);
        }
        assert.equal(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join(""), line);
      }
    }
  });

  test("folds count octets, not characters: 40 three-octet characters need two lines", () => {
    const parts = foldIcsLine("東".repeat(40)).split("\r\n");
    assert.equal(parts.length, 2);
    assert.equal(parts[0], "東".repeat(25), "25 × 3 = 75 octets");
    assert.equal(parts[1], ` ${"東".repeat(15)}`);
  });
});

describe("all-day events", () => {
  test("DTEND is the day after the last day off, across month, leap day and year ends", () => {
    assert.equal(exclusiveEndDate("2026-11-02"), "2026-11-03");
    assert.equal(exclusiveEndDate("2026-11-30"), "2026-12-01");
    assert.equal(exclusiveEndDate("2026-02-28"), "2026-03-01");
    assert.equal(exclusiveEndDate("2028-02-28"), "2028-02-29");
    assert.equal(exclusiveEndDate("2026-12-31"), "2027-01-01");
  });

  test("a one-day event and a range serialize as DATE values with an exclusive end", () => {
    const vcal = parseIcs(
      serializeCalendar(calendar([event(), event({ uid: "b@ooohm", startDate: "2026-12-28", endDate: "2027-01-04" })])),
    );
    const [day, range] = vcal.components;
    assert.deepEqual(only(day, "DTSTART"), { name: "DTSTART", params: { VALUE: "DATE" }, value: "20261102" });
    assert.deepEqual(only(day, "DTEND"), { name: "DTEND", params: { VALUE: "DATE" }, value: "20261103" });
    assert.equal(only(range, "DTSTART").value, "20261228");
    assert.equal(only(range, "DTEND").value, "20270105");
  });

  test("dates that are not real, or end before they start, are refused", () => {
    assert.throws(() => serializeCalendar(calendar([event({ startDate: "2026-02-30" })])), RangeError);
    assert.throws(() => serializeCalendar(calendar([event({ startDate: "2026-11-03", endDate: "2026-11-02" })])), RangeError);
  });
});

describe("the calendar document", () => {
  test("is a valid published calendar with every property subscribers rely on", () => {
    const text = serializeCalendar(calendar([event({ lastModified: new Date("2026-10-30T08:00:00Z") })]));
    assert.ok(!/(?<!\r)\n/.test(text), "only CRLF line breaks");
    const vcal = parseIcs(text);
    assert.equal(vcal.name, "VCALENDAR");
    assert.equal(only(vcal, "VERSION").value, "2.0");
    assert.match(only(vcal, "PRODID").value, /^-\/\/OOOhm\/\//);
    assert.equal(only(vcal, "CALSCALE").value, "GREGORIAN");
    assert.equal(only(vcal, "METHOD").value, "PUBLISH");
    assert.equal(only(vcal, "X-WR-CALNAME").value, "OOOhm: My time off");
    assert.equal(only(vcal, "NAME").value, "OOOhm: My time off");
    assert.deepEqual(only(vcal, "REFRESH-INTERVAL"), { name: "REFRESH-INTERVAL", params: { VALUE: "DURATION" }, value: "PT1H" });
    assert.equal(only(vcal, "X-PUBLISHED-TTL").value, "PT1H");

    assert.equal(vcal.components.length, 1);
    const vevent = vcal.components[0];
    assert.equal(vevent.name, "VEVENT");
    assert.equal(only(vevent, "UID").value, "4b0d6a0e-3c0b-4b8a-9d55-0d1c7a1f2e3b@ooohm");
    assert.equal(only(vevent, "DTSTAMP").value, "20261101T150405Z", "UTC, whole seconds");
    assert.equal(only(vevent, "SUMMARY").value, "PTO");
    assert.equal(only(vevent, "STATUS").value, "CONFIRMED");
    assert.equal(only(vevent, "TRANSP").value, "OPAQUE");
    assert.equal(only(vevent, "LAST-MODIFIED").value, "20261030T080000Z");
  });

  test("an empty calendar is still valid", () => {
    const vcal = parseIcs(serializeCalendar(calendar([])));
    assert.equal(vcal.components.length, 0);
  });

  test("names and summaries with commas, semicolons, newlines and long multibyte text survive", () => {
    const summary = "Zoë Ångström-Ñúñez, Jr.; 東京オフィス\nSecond line: PTO (AM, pending) 😀".repeat(2);
    const name = "OOOhm: Who's out at Smith, Jones; Partners";
    const vcal = parseIcs(serializeCalendar(calendar([event({ summary })], name)));
    assert.equal(unescapeText(only(vcal, "X-WR-CALNAME").value), name);
    assert.equal(unescapeText(only(vcal.components[0], "SUMMARY").value), summary);
  });

  test("UIDs are stable: the same request gives the same UID on every refresh", () => {
    const entry = personalEntry();
    const first = parseIcs(serializeCalendar(buildFeedCalendar({ kind: "personal", calendarName: "x", entries: [entry] }, generatedAt)));
    const later = parseIcs(
      serializeCalendar(
        buildFeedCalendar({ kind: "personal", calendarName: "x", entries: [{ ...entry, status: "approved" }] }, new Date("2027-01-01T00:00:00Z")),
      ),
    );
    assert.equal(only(first.components[0], "UID").value, `${entry.id}@ooohm`);
    assert.equal(only(later.components[0], "UID").value, only(first.components[0], "UID").value);
    assert.notEqual(only(later.components[0], "DTSTAMP").value, only(first.components[0], "DTSTAMP").value);
    assert.equal(feedEventUid(entry.id), `${entry.id}@ooohm`);
  });
});

function personalEntry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: "0c5b2d55-8a4d-4f0e-9a51-7f6f1b9f0a10",
    userId: "u1",
    startDate: "2026-11-02",
    endDate: "2026-11-02",
    dayPortion: "full",
    status: "pending",
    leaveTypeName: "PTO (Scheduled Time Off)",
    leaveTypeCode: "PTO",
    leaveTypeColor: "#0f766e",
    updatedAt: new Date("2026-10-30T08:00:00Z"),
    ...overrides,
  };
}

describe("feed events", () => {
  test("titles name the leave type, add the half and pending, and the person only in team feeds", () => {
    const e = (dayPortion: CalendarEntry["dayPortion"], status: CalendarEntry["status"]) => ({ leaveTypeCode: "PTO", dayPortion, status });
    assert.equal(feedEventSummary(e("full", "approved")), "PTO");
    assert.equal(feedEventSummary(e("am", "approved")), "PTO (AM)");
    assert.equal(feedEventSummary(e("pm", "approved")), "PTO (PM)");
    assert.equal(feedEventSummary(e("full", "pending")), "PTO (pending)");
    assert.equal(feedEventSummary(e("am", "pending")), "PTO (AM, pending)");
    assert.equal(feedEventSummary(e("full", "approved"), "Ana"), "Ana: PTO");
    assert.equal(feedEventSummary(e("pm", "pending"), "Ana"), "Ana: PTO (PM, pending)");
  });

  test("pending leave is tentative and approved confirmed; your own leave marks you busy, the team's does not", () => {
    const pending = personalEntry();
    const approved = personalEntry({ id: "b", status: "approved", dayPortion: "am" });
    const personal = buildFeedCalendar({ kind: "personal", calendarName: "Mine", entries: [pending, approved] }, generatedAt);
    assert.deepEqual(
      personal.events.map((e) => [e.summary, e.status, e.transparency]),
      [
        ["PTO (pending)", "TENTATIVE", "OPAQUE"],
        ["PTO (AM)", "CONFIRMED", "OPAQUE"],
      ],
    );

    const team: TeamCalendarEntry = { ...approved, personName: "Ana", departmentName: null };
    const teamCal = buildFeedCalendar({ kind: "team", calendarName: "Team", entries: [team] }, generatedAt);
    assert.deepEqual(
      teamCal.events.map((e) => [e.summary, e.status, e.transparency, e.uid]),
      [["Ana: PTO (AM)", "CONFIRMED", "TRANSPARENT", "b@ooohm"]],
    );
  });

  test("the window runs from 90 days back to about 18 months ahead", () => {
    assert.deepEqual(feedWindow("2026-11-01"), { from: "2026-08-03", to: "2028-05-02" });
  });
});
