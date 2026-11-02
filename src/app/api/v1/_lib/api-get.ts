import "server-only";
import type { NextRequest } from "next/server";
import type { ApiClient } from "@/domain/integrations";
import { clientAddress } from "@/lib/client-address";
import { env } from "@/lib/env";
import { createRateLimiter } from "@/lib/rate-limit";
import { serviceContext } from "@/server/runtime";
import type { ServiceContext } from "@/server/context";
import { type ApiLimits, handleApiRequest, REQUESTS_PER_KEY_PER_MINUTE, UNAUTHORIZED_PER_CLIENT_PER_MINUTE } from "./handler";

/**
 * Per-process limits, shared by every `/api/v1` route. The app runs as one standalone
 * server, so one process's memory is the whole picture; behind several instances each
 * would count separately (docs/api.md#rate-limits). Both are bounded in memory.
 */
const limits: ApiLimits = {
  perKey: createRateLimiter({ limit: REQUESTS_PER_KEY_PER_MINUTE, windowMs: 60_000 }),
  unauthorized: createRateLimiter({ limit: UNAUTHORIZED_PER_CLIENT_PER_MINUTE, windowMs: 60_000 }),
};

/** Runs one `/api/v1` GET through {@link handleApiRequest} with the app's context and limits. */
export function apiGet(request: NextRequest, work: (ctx: ServiceContext, client: ApiClient, query: URLSearchParams) => Promise<unknown>) {
  const ctx = serviceContext();
  return handleApiRequest(
    { ctx, headers: request.headers, client: clientAddress(request.headers, env.TRUSTED_PROXY_HOPS), limits, route: request.nextUrl.pathname },
    (client) => work(ctx, client, request.nextUrl.searchParams),
  );
}
