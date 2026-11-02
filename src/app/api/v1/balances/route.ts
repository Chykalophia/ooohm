import type { NextRequest } from "next/server";
import { listBalancesForApi } from "@/server/services/api-v1";
import { parseQuery } from "@/app/api/v1/_lib/handler";
import { balancesQuery } from "@/app/api/v1/_lib/query";
import { apiGet } from "@/app/api/v1/_lib/api-get";

/** `GET /api/v1/balances?year&userId`: balances per person and leave type for one year. */
export async function GET(request: NextRequest): Promise<Response> {
  return apiGet(request, (ctx, client, query) => listBalancesForApi(ctx, client, parseQuery(balancesQuery, query)));
}
