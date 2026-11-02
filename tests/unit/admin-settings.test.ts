import assert from "node:assert/strict";
import { test } from "node:test";
import { isoWeekday } from "@/domain/calendar-date";
import { isSupportedTimeZone, normalizeCompanySettings, normalizeWorkingDays } from "@/domain/company-settings";
import { type DomainErrorCode, isDomainError } from "@/domain/errors";
import { usFederalHolidays } from "@/domain/holidays";
import {
  ALLOWANCE_YEAR_MAX,
  assertAllowanceYear,
  firstEditableAllowanceYear,
  normalizeAllowanceEdit,
  normalizeDayAmount,
  normalizeLeaveTypeCode,
  normalizeLeaveTypeColor,
  normalizeLeaveTypeSettings,
} from "@/domain/leave-type-settings";

function throwsCode(fn: () => unknown, code: DomainErrorCode) {
  assert.throws(fn, (err) => isDomainError(err, code));
}

const settings = { name: "Acme", timezone: "America/Chicago", workingDays: [1, 2, 3, 4, 5], allowancePolicy: "annual_calendar_year" };

test("time zones come from Intl.supportedValuesOf, plus UTC", () => {
  assert.equal(isSupportedTimeZone("America/Chicago"), true);
  assert.equal(isSupportedTimeZone("Europe/Warsaw"), true);
  assert.equal(isSupportedTimeZone("UTC"), true);
  assert.equal(isSupportedTimeZone("Mars/Olympus_Mons"), false);
  assert.equal(isSupportedTimeZone("america/chicago"), false, "names are exact");
  assert.equal(isSupportedTimeZone(""), false);
});

test("company settings: a new zone must be supported, an unchanged stored alias is kept", () => {
  assert.equal(normalizeCompanySettings({ ...settings, timezone: "UTC" }).timezone, "UTC");
  throwsCode(() => normalizeCompanySettings({ ...settings, timezone: "Mars/Olympus_Mons" }), "invalid_input");
  // An alias ICU does not list: refused as a new choice, kept when it is what is stored.
  const alias = isSupportedTimeZone("Asia/Kolkata") ? "Etc/Unknown_Alias" : "Asia/Kolkata";
  throwsCode(() => normalizeCompanySettings({ ...settings, timezone: alias }, "America/Chicago"), "invalid_input");
  assert.equal(normalizeCompanySettings({ ...settings, timezone: alias }, alias).timezone, alias);
});

test("company settings: name is required and trimmed, policy must be registered", () => {
  assert.equal(normalizeCompanySettings({ ...settings, name: "  Acme \n Inc " }).name, "Acme Inc");
  throwsCode(() => normalizeCompanySettings({ ...settings, name: "  " }), "invalid_input");
  throwsCode(() => normalizeCompanySettings({ ...settings, name: "x".repeat(101) }), "invalid_input");
  throwsCode(() => normalizeCompanySettings({ ...settings, allowancePolicy: "accrual_monthly" }), "invalid_input");
});

test("working days: at least one ISO weekday, deduplicated and sorted", () => {
  assert.deepEqual(normalizeWorkingDays([5, 1, 1, 3]), [1, 3, 5]);
  assert.deepEqual(normalizeWorkingDays([7]), [7]);
  throwsCode(() => normalizeWorkingDays([]), "invalid_input");
  throwsCode(() => normalizeWorkingDays([0]), "invalid_input");
  throwsCode(() => normalizeWorkingDays([8]), "invalid_input");
  throwsCode(() => normalizeWorkingDays([1.5]), "invalid_input");
});

test("leave type codes are uppercased short codes", () => {
  assert.equal(normalizeLeaveTypeCode(" pto "), "PTO");
  assert.equal(normalizeLeaveTypeCode("wfh-2"), "WFH-2");
  for (const bad of ["", "P T O", "-PTO", "ÉTÉ", "ABCDEFGHIJKLM"]) throwsCode(() => normalizeLeaveTypeCode(bad), "invalid_input");
});

test("leave type colours are #rrggbb, lowercased; #rgb expands; anything else is refused", () => {
  assert.equal(normalizeLeaveTypeColor("#0F766E"), "#0f766e");
  assert.equal(normalizeLeaveTypeColor("#AbC"), "#aabbcc");
  for (const bad of ["teal", "#12345", "0f766e", "#0f766eff", "rgb(0,0,0)"]) throwsCode(() => normalizeLeaveTypeColor(bad), "invalid_input");
});

test("day amounts are whole tenths within range", () => {
  assert.equal(normalizeDayAmount(2.5, { min: 0, max: 366 }), 2.5);
  assert.equal(normalizeDayAmount(0.1 + 0.2, { min: 0, max: 366 }), 0.3);
  throwsCode(() => normalizeDayAmount(2.55, { min: 0, max: 366 }), "invalid_input");
  throwsCode(() => normalizeDayAmount(-1, { min: 0, max: 366 }), "invalid_input");
  throwsCode(() => normalizeDayAmount(367, { min: 0, max: 366 }), "invalid_input");
  throwsCode(() => normalizeDayAmount(Number.NaN, { min: 0, max: 366 }), "invalid_input");
});

test("leave type settings: defaults and caps may be null (no default, no cap) but never negative", () => {
  const base = {
    name: " Parental  leave ",
    code: "parental",
    color: "#7C3AED",
    isPaid: true,
    countsAgainstAllowance: true,
    defaultAllowanceDays: null,
    carryoverEnabled: false,
    carryoverMaxDays: null,
  };
  assert.deepEqual(normalizeLeaveTypeSettings(base), { ...base, name: "Parental leave", code: "PARENTAL", color: "#7c3aed" });
  assert.equal(normalizeLeaveTypeSettings({ ...base, defaultAllowanceDays: 15 }).defaultAllowanceDays, 15);
  throwsCode(() => normalizeLeaveTypeSettings({ ...base, defaultAllowanceDays: -1 }), "invalid_input");
  throwsCode(() => normalizeLeaveTypeSettings({ ...base, carryoverMaxDays: -0.5 }), "invalid_input");
  throwsCode(() => normalizeLeaveTypeSettings({ ...base, name: "" }), "invalid_input");
});

test("allowance edits need a reason; days are 0 or more, adjustments may be negative", () => {
  assert.deepEqual(normalizeAllowanceEdit({ days: 20, adjustmentDays: -1.5, reason: " Joined mid-year " }), {
    days: 20,
    adjustmentDays: -1.5,
    reason: "Joined mid-year",
  });
  throwsCode(() => normalizeAllowanceEdit({ days: 20, adjustmentDays: 0, reason: "  " }), "invalid_input");
  throwsCode(() => normalizeAllowanceEdit({ days: -1, adjustmentDays: 0, reason: "x" }), "invalid_input");
  throwsCode(() => normalizeAllowanceEdit({ days: 1, adjustmentDays: -367, reason: "x" }), "invalid_input");
  throwsCode(() => normalizeAllowanceEdit({ days: 1, adjustmentDays: 0, reason: "x".repeat(501) }), "invalid_input");
});

test("US federal holidays for 2026, on the days they are observed", () => {
  assert.deepEqual(usFederalHolidays(2026), [
    { date: "2026-01-01", name: "New Year's Day" },
    { date: "2026-01-19", name: "Birthday of Martin Luther King, Jr." },
    { date: "2026-02-16", name: "Washington's Birthday" },
    { date: "2026-05-25", name: "Memorial Day" },
    { date: "2026-06-19", name: "Juneteenth National Independence Day" },
    { date: "2026-07-03", name: "Independence Day (observed)" },
    { date: "2026-09-07", name: "Labor Day" },
    { date: "2026-10-12", name: "Columbus Day" },
    { date: "2026-11-11", name: "Veterans Day" },
    { date: "2026-11-26", name: "Thanksgiving Day" },
    { date: "2026-12-25", name: "Christmas Day" },
  ]);
});

test("a Saturday New Year's Day is observed on Dec 31 of the year before, so it moves between years", () => {
  // Jan 1 2022 was a Saturday.
  const y2021 = usFederalHolidays(2021);
  const y2022 = usFederalHolidays(2022);
  assert.deepEqual(y2021.at(-1), { date: "2021-12-31", name: "New Year's Day (observed)" });
  assert.equal(y2021.length, 12);
  assert.equal(y2022.length, 10);
  assert.ok(!y2022.some((h) => h.name.startsWith("New Year")));
  assert.deepEqual(y2022.at(-1), { date: "2022-12-26", name: "Christmas Day (observed)" }, "Sunday moves to Monday");
});

test("every observed federal holiday falls on a weekday, every year", () => {
  for (let year = 2020; year <= 2040; year++) {
    for (const h of usFederalHolidays(year)) {
      assert.ok(isoWeekday(h.date) <= 5, `${h.date} ${h.name}`);
      assert.ok(h.date.startsWith(`${year}-`));
    }
  }
});

test("allowances are editable from last year on: older years are closed, the rollover no longer re-carries them", () => {
  assert.equal(firstEditableAllowanceYear(2026), 2025);
  for (const year of [2025, 2026, 2027, ALLOWANCE_YEAR_MAX]) assert.doesNotThrow(() => assertAllowanceYear(year, 2026), String(year));
  for (const year of [2024, 2000, ALLOWANCE_YEAR_MAX + 1, 2026.5, Number.NaN]) throwsCode(() => assertAllowanceYear(year, 2026), "invalid_input");
});
