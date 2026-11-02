import type { NextRequest } from "next/server";
import { listLeaveRequestsForApi } from "@/server/services/api-v1";
import { parseQuery } from "@/app/api/v1/_lib/handler";
import { leaveRequestsQuery } from "@/app/api/v1/_lib/query";
import { apiGet } from "@/app/api/v1/_lib/api-get";

/** `GET /api/v1/leave-requests?from&to&userId&status&cursor&limit`: leave requests by start date, without notes. */
export async function GET(request: NextRequest): Promise<Response> {
  return apiGet(request, (ctx, client, query) => listLeaveRequestsForApi(ctx, client, parseQuery(leaveRequestsQuery, query)));
}
