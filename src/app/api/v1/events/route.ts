import type { NextRequest } from "next/server";
import { listEventsForApi } from "@/server/services/api-v1";
import { parseQuery } from "@/app/api/v1/_lib/handler";
import { eventsQuery } from "@/app/api/v1/_lib/query";
import { apiGet } from "@/app/api/v1/_lib/api-get";

/** `GET /api/v1/events?after&limit`: replay of the event outbox, for integrations that poll. */
export async function GET(request: NextRequest): Promise<Response> {
  return apiGet(request, (ctx, client, query) => listEventsForApi(ctx, client, parseQuery(eventsQuery, query)));
}
