import type { NextRequest } from "next/server";
import { listHolidaysForApi } from "@/server/services/api-v1";
import { parseQuery } from "@/app/api/v1/_lib/handler";
import { holidaysQuery } from "@/app/api/v1/_lib/query";
import { apiGet } from "@/app/api/v1/_lib/api-get";

/** `GET /api/v1/holidays?year`: the company's holidays in one year, by date. */
export async function GET(request: NextRequest): Promise<Response> {
  return apiGet(request, (ctx, client, query) => listHolidaysForApi(ctx, client, parseQuery(holidaysQuery, query)));
}
