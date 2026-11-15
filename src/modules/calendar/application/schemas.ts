import "server-only";
import { z } from "zod";
import { CALENDAR_FILTERS } from "@/domain/calendar-visibility";
import { isYearMonth } from "@/domain/calendar";

/** `?month=YYYY-MM`. */
export const monthParamSchema = z.string().refine(isYearMonth);
/** `?show=team` or `?show=everyone` on the calendar; the service still checks the viewer may. */
export const calendarFilterParamSchema = z.enum(CALENDAR_FILTERS);
