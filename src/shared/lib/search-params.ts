import { z } from "zod";
import { MAX_CALENDAR_YEAR, MIN_CALENDAR_YEAR } from "@/domain/calendar";
import { isUuid } from "@/domain/ids";

/** `?department=<uuid>`. */
export const departmentParamSchema = z.string().refine(isUuid);

/** `?year=YYYY`, within the years the calendar shows. */
export const yearParamSchema = z
  .string()
  .regex(/^\d{4}$/)
  .refine((y) => Number(y) >= MIN_CALENDAR_YEAR && Number(y) <= MAX_CALENDAR_YEAR);

/**
 * A search param through `schema`, or `undefined` when it is missing, repeated or
 * malformed, so a bad link falls back to the default view instead of failing.
 */
export function readParam(schema: z.ZodType<string>, value: string | string[] | undefined): string | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
