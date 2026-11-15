import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { toCalendarHolidayDTO, toFeedSummary, toTeamEntry, type TeamEntrySource } from "@/modules/calendar/application/dto";

/**
 * What leaves the calendar module. Calendars are seen by people other than the requester,
 * so a team entry carries a label, never the email it falls back on; a feed summary
 * carries no id, owner or token hash.
 */

const entry: TeamEntrySource = {
  id: "r-1",
  userId: "u-1",
  startDate: "2026-07-06",
  endDate: "2026-07-10",
  dayPortion: "full",
  status: "approved",
  updatedAt: new Date("2026-06-01T00:00:00Z"),
  leaveTypeName: "Paid time off",
  leaveTypeCode: "PTO",
  leaveTypeColor: "#0f766e",
  personName: "Ana Ruiz",
  departmentName: "Support",
  personEmail: "ana.ruiz@acme.test",
};

describe("toTeamEntry", () => {
  test("labels the person by name and drops the email", () => {
    const dto = toTeamEntry(entry);
    assert.equal(dto.personName, "Ana Ruiz");
    assert.ok(!("personEmail" in dto));
    assert.ok(!Object.values(dto).includes("ana.ruiz@acme.test"));
  });

  test("a blank name falls back on the email's local part, never the whole address", () => {
    const dto = toTeamEntry({ ...entry, personName: "  " });
    assert.equal(dto.personName, "ana.ruiz");
    assert.ok(!JSON.stringify(dto).includes("@acme.test"));
  });

  test("never carries a note", () => {
    const dto = toTeamEntry(entry);
    assert.ok(!("note" in dto));
    assert.ok(!("decisionNote" in dto));
  });
});

describe("toFeedSummary", () => {
  test("is when the link was made, last used and its hint: no id, owner, kind or hash", () => {
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const row = { id: "f-1", userId: "u-1", kind: "team", tokenHash: "secret", createdAt, lastUsedAt: null, tokenHint: "ab12" };
    const dto = toFeedSummary(row);
    assert.deepEqual(dto, { createdAt, lastUsedAt: null, hint: "ab12" });
  });
});

describe("toCalendarHolidayDTO", () => {
  test("is a holiday's id, date and name", () => {
    const row = { id: "h-1", date: "2026-12-25", name: "Christmas", companyId: "c-1" };
    assert.deepEqual(toCalendarHolidayDTO(row), { id: "h-1", date: "2026-12-25", name: "Christmas" });
  });
});
