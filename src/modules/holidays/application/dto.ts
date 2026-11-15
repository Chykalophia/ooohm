import "server-only";
import type { RecountOutcome } from "@/modules/leave";

/** One day of a company holiday, as the admin screen, the API and the import see it. */
export interface HolidayDTO {
  id: string;
  /** `YYYY-MM-DD`. */
  date: string;
  name: string;
}

export function toHolidayDTO({ id, date, name }: HolidayDTO): HolidayDTO {
  return { id, date, name };
}

/** The admin screen's year: the year shown and its holidays, by date. */
export interface HolidayYearDTO {
  year: number;
  holidays: HolidayDTO[];
}

/** A holiday added alone, and what the recount of the requests on its date changed. */
export interface AddedHolidayDTO {
  holiday: HolidayDTO;
  recount: RecountOutcome;
}

/** The days a run added, the dates skipped because they already had a holiday, and the recount. */
export interface AddedHolidayRangeDTO {
  added: HolidayDTO[];
  skipped: string[];
  recount: RecountOutcome;
}

/** The US federal holidays added (none when all were there already), and the recount. */
export interface AddedFederalHolidaysDTO {
  added: HolidayDTO[];
  recount: RecountOutcome;
}
