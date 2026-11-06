import { departmentParamSchema, readParam, yearParamSchema } from "./calendar-input";

type Params = Record<string, string | string[] | undefined>;

/** A URL's query as a page's `searchParams` gives it: a repeated key becomes an array. */
export function searchParamsRecord(params: URLSearchParams): Params {
  const out: Params = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    out[key] = values.length === 1 ? values[0] : values;
  }
  return out;
}

/**
 * The Reports page's and its CSV export's `?year=` and `?department=`, read the same way
 * for both: a missing, repeated or malformed value means the default view.
 */
export function readReportQuery(params: Params): { year: number | undefined; departmentId: string | undefined } {
  const year = readParam(yearParamSchema, params.year);
  return { year: year === undefined ? undefined : Number(year), departmentId: readParam(departmentParamSchema, params.department) };
}
