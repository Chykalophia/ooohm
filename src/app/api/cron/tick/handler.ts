import { isCronAuthorized } from "@/lib/cron-auth";

const headers = { "Cache-Control": "no-store" };

export interface CronTickDeps {
  /** `CRON_SECRET`; unset means every call is refused. */
  secret: string | undefined;
  /** Runs one tick and returns its counts. */
  tick: () => Promise<Record<string, number | boolean>>;
  /** Told once per refused call while no secret is configured, so an operator can find out why. */
  onUnconfigured?: () => void;
}

/**
 * `GET /api/cron/tick`, kept free of Next.js so it can be tested directly: 401 with an
 * empty body unless the request carries `Authorization: Bearer <CRON_SECRET>`; otherwise
 * one background tick and its counts as JSON. Never cached. A tick that fails (the
 * database is down) is a 500 with a bare error code; the scheduler retries on its next
 * run.
 */
export async function handleCronTick(request: Request, deps: CronTickDeps): Promise<Response> {
  if (!deps.secret) deps.onUnconfigured?.();
  if (!isCronAuthorized(request.headers.get("authorization"), deps.secret)) {
    return new Response(null, { status: 401, headers });
  }
  try {
    return Response.json({ status: "ok", ...(await deps.tick()) }, { headers });
  } catch {
    return Response.json({ status: "error" }, { status: 500, headers });
  }
}
