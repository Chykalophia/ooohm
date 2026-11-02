import type { NextRequest } from "next/server";
import { listLeaveTypesForApi } from "@/server/services/api-v1";
import { apiGet } from "@/app/api/v1/_lib/api-get";

/** `GET /api/v1/leave-types`: every leave type, archived ones flagged, in display order. */
export async function GET(request: NextRequest): Promise<Response> {
  return apiGet(request, (ctx, client) => listLeaveTypesForApi(ctx, client));
}
