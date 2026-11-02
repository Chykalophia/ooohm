import { z } from "zod";
import { isYearMonth } from "@/domain/calendar";
import { isUuid } from "@/domain/ids";

/** `?month=YYYY-MM`. */
export const monthParamSchema = z.string().refine(isYearMonth);
/** `?department=<uuid>`. */
export const departmentParamSchema = z.string().refine(isUuid);

/**
 * A search param through `schema`, or `undefined` when it is missing, repeated or
 * malformed, so a bad link falls back to the default view instead of failing.
 */
export function readParam(schema: z.ZodType<string>, value: string | string[] | undefined): string | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
