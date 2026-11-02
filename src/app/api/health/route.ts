import { serviceContext } from "@/server/runtime";
import { isDatabaseReachable } from "@/server/services/health";

const headers = { "Cache-Control": "no-store" };

/**
 * Liveness and readiness for the container healthcheck and uptime monitors: 200 when the
 * database answers, 503 when it does not. Public, so it says nothing more than that.
 */
export async function GET() {
  if (await isDatabaseReachable(serviceContext())) return Response.json({ status: "ok" }, { headers });
  return Response.json({ status: "unavailable" }, { status: 503, headers });
}
