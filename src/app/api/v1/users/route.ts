import type { NextRequest } from "next/server";
import { listUsersForApi } from "@/server/services/api-v1";
import { parseQuery } from "@/app/api/v1/_lib/handler";
import { usersQuery } from "@/app/api/v1/_lib/query";
import { apiGet } from "@/app/api/v1/_lib/api-get";

/** `GET /api/v1/users?cursor&limit`: the company's people, active and not, by id. */
export async function GET(request: NextRequest): Promise<Response> {
  return apiGet(request, (ctx, client, query) => listUsersForApi(ctx, client, parseQuery(usersQuery, query)));
}
