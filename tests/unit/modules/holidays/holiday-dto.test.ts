import assert from "node:assert/strict";
import { test } from "node:test";
import { type HolidayDTO, toHolidayDTO } from "@/modules/holidays/application/dto";

/** What leaves the holidays module for a holiday: its id, date and name, never the company or timestamps. */
test("toHolidayDTO is a holiday's id, date and name", () => {
  const row = { id: "h-1", date: "2026-12-25", name: "Christmas", companyId: "c-1", createdAt: new Date() };
  const dto = toHolidayDTO(row as HolidayDTO);
  assert.deepEqual(Object.keys(dto).sort(), ["date", "id", "name"]);
  assert.deepEqual(dto, { id: "h-1", date: "2026-12-25", name: "Christmas" });
});
