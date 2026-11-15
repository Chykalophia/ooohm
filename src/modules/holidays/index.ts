import "server-only";
/**
 * The holidays module's public API (see README.md): the company's holidays, one day or a
 * run of days, and the US federal set. Everything outside the module imports from here.
 */

export { listHolidaysForAdmin } from "./application/queries/list-holidays-for-admin";
export { addHoliday } from "./application/use-cases/add-holiday";
export { addHolidayRange } from "./application/use-cases/add-holiday-range";
export { addUsFederalHolidays } from "./application/use-cases/add-us-federal-holidays";
export { renameHoliday } from "./application/use-cases/rename-holiday";
export { renameHolidays } from "./application/use-cases/rename-holidays";
export { deleteHoliday } from "./application/use-cases/delete-holiday";
export { deleteHolidays } from "./application/use-cases/delete-holidays";

// A step for the TimeOff import, on its transaction (it reads holidays through `@/modules/calendar`).
export { insertHolidays } from "./application/steps/insert-holidays";

export { canManageHolidays } from "./application/policies";
export { groupHolidays, HOLIDAY_RANGE_MAX_DAYS, holidayRangeDates, type HolidayGroup } from "./domain/holiday-range";
export { usFederalHolidays, type HolidayDraft } from "./domain/us-federal-holidays";
export type { AddedFederalHolidaysDTO, AddedHolidayDTO, AddedHolidayRangeDTO, HolidayDTO, HolidayYearDTO } from "./application/dto";
