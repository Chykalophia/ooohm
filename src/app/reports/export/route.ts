import { toActor } from "@/domain/actor";
import { isDomainError } from "@/domain/errors";
import { currentUser } from "@/lib/auth";
import { isCrossSiteRequest } from "@/lib/fetch-site";
import { log } from "@/lib/log";
import { serviceContext } from "@/server/runtime";
import { exportLeaveReport } from "@/server/services/reports";
import { departmentParamSchema, readParam, yearParamSchema } from "@/app/_lib/calendar-input";

/** Holds balances and names: never stored by a browser or a proxy. */
const PRIVATE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

function bare(status: number): Response {
  return new Response(null, { status, headers: PRIVATE });
}

/**
 * `GET /reports/export?year=YYYY&department=<id>`: the Reports page's people table as
 * CSV, for the same people (an admin's company, a manager's direct reports). Anyone else
 * gets a bare 404, as the page does. Only OOOhm's own pages, or a typed address, may ask
 * (`Sec-Fetch-Site`), so another site cannot pull a signed-in manager's download.
 */
export async function GET(request: Request): Promise<Response> {
  if (isCrossSiteRequest(request.headers)) return bare(404);
  const user = await currentUser();
  if (!user) return bare(401);
  const actor = toActor(user);
  if (!actor) return bare(404);
  const params = new URL(request.url).searchParams;
  // As the page reads them: a repeated key counts as missing.
  const one = (key: string) => {
    const values = params.getAll(key);
    return values.length === 1 ? values[0] : undefined;
  };
  const year = readParam(yearParamSchema, one("year"));

  try {
    const { filename, csv } = await exportLeaveReport(serviceContext(), actor, {
      year: year === undefined ? undefined : Number(year),
      departmentId: readParam(departmentParamSchema, one("department")),
    });
    return new Response(csv, {
      headers: {
        ...PRIVATE,
        "Content-Type": "text/csv; charset=utf-8",
        // The name is a number and a [a-z0-9-] slug; the encoded form keeps it safe whatever it becomes.
        "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  } catch (err) {
    if (isDomainError(err, "not_found")) return bare(404);
    log.error({ err }, "report_export_failed");
    return bare(500);
  }
}
