/**
 * Planning step: the working calendar TimeOff counts each person's leave on.
 */
import type { CalendarDate } from "@/shared/kernel/calendar-date";
import { scheduleWorkingDays, type TimeOffWorkCalendar } from "../balance";
import type { TimeOffSnapshot } from "../source";
import { sameDays } from "./rules";
import type { KeptUser, Warn } from "./types";

export interface CalendarPlan {
  /** TimeOff user id → their working calendar in TimeOff (their own schedule, else the company's). */
  calendarOf: Map<number, TimeOffWorkCalendar>;
  /** Users whose own schedule differs from the company's. */
  ownSchedule: Set<number>;
  /** The company's schedule with TimeOff's holidays. */
  companyWork: TimeOffWorkCalendar;
}

/** Each kept person's TimeOff calendar; a schedule of their own is a warning, as OOOhm counts the company's days for everyone. */
export function planCalendars(kept: readonly KeptUser[], snapshot: TimeOffSnapshot, workingDays: readonly number[], holidayDates: ReadonlySet<CalendarDate>, warn: Warn): CalendarPlan {
  const calendarOf = new Map<number, TimeOffWorkCalendar>();
  const ownSchedule = new Set<number>();
  for (const { user: u, email } of kept) {
    const own = snapshot.schedules.find((s) => s.userId === u.id);
    const days = own ? scheduleWorkingDays(own) : [...workingDays];
    if (own && !sameDays(days, workingDays)) {
      ownSchedule.add(u.id);
      warn({
        code: "personal_schedule",
        email,
        message: `${email} has their own TimeOff schedule (ISO weekdays ${days.join(",") || "none"}); OOOhm counts the company's working days (${workingDays.join(",")}) for everyone.`,
      });
    }
    calendarOf.set(u.id, { workingDays: new Set(days), holidays: holidayDates });
  }
  return { calendarOf, ownSchedule, companyWork: { workingDays: new Set(workingDays), holidays: holidayDates } };
}
