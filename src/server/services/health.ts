import type { ServiceContext } from "@/server/context";
import { ping } from "@/server/repositories/health";

/** True when the database answers a trivial query. Never throws. */
export async function isDatabaseReachable(ctx: Pick<ServiceContext, "db">): Promise<boolean> {
  try {
    await ping(ctx.db);
    return true;
  } catch {
    return false;
  }
}
