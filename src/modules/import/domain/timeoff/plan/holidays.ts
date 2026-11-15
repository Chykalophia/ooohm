/**
 * Planning step: TimeOff's bank holidays, and the company calendar OOOhm counts imported
 * leave against.
 */
import { type CalendarDate, isCalendarDate } from "@/domain/calendar-date";
import { normalizeHolidayName } from "@/domain/holidays";
import type { TimeOffBankHoliday, TimeOffSnapshot } from "../source";
import type { PlannedHoliday, Warn } from "./types";

export interface HolidayPlan {
  holidays: PlannedHoliday[];
  /** TimeOff's holiday dates: what TimeOff's own figures count against. */
  holidayDates: Set<CalendarDate>;
  /** The company calendar after the import: TimeOff's holidays and the ones the company already has. */
  ooohmHolidays: Set<CalendarDate>;
  /** Dates only OOOhm treats as holidays. */
  extraHolidays: CalendarDate[];
}

/** A holiday's name as OOOhm keeps it; a name OOOhm refuses is cut to 100 characters, or "Holiday" when blank. */
function holidayName(h: Pick<TimeOffBankHoliday, "name">): string {
  try {
    return normalizeHolidayName(h.name);
  } catch {
    return h.name.trim() ? h.name.trim().slice(0, 100) : "Holiday";
  }
}

/** The company's bank holidays by date, one per date (the first), skipping invalid dates. */
export function planHolidays(snapshot: TimeOffSnapshot, companyId: number, existing: ReadonlySet<CalendarDate> | undefined, warn: Warn): HolidayPlan {
  const holidays: PlannedHoliday[] = [];
  const holidayDates = new Set<CalendarDate>();
  const sorted = snapshot.bankHolidays.filter((b) => b.companyId === companyId).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  for (const h of sorted) {
    if (!isCalendarDate(h.date)) {
      warn({ code: "holiday_invalid", message: `Bank holiday ${h.id} has no valid date; skipped.`, timeoffId: h.id });
      continue;
    }
    if (holidayDates.has(h.date)) {
      warn({ code: "holiday_duplicate", message: `Two bank holidays on ${h.date}; kept the first.`, timeoffId: h.id });
      continue;
    }
    holidayDates.add(h.date);
    holidays.push({ date: h.date, name: holidayName(h), timeoffId: h.id });
  }
  const ooohmHolidays = new Set<CalendarDate>([...holidayDates, ...(existing ?? [])]);
  return { holidays, holidayDates, ooohmHolidays, extraHolidays: [...ooohmHolidays].filter((d) => !holidayDates.has(d)) };
}
