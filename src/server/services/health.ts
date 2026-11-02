import { log } from "@/lib/log";
import type { ServiceContext } from "@/server/context";
import { ping } from "@/server/repositories/health";

/** True when the database answers a trivial query. Never throws; a failure is logged. */
export async function isDatabaseReachable(ctx: Pick<ServiceContext, "db">): Promise<boolean> {
  try {
    await ping(ctx.db);
    return true;
  } catch (err) {
    log.warn({ err }, "health_database_unreachable");
    return false;
  }
}
