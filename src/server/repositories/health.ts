import { sql } from "drizzle-orm";
import type { Executor } from "@/db/types";

/** Round-trips a trivial query. Throws when the database is unreachable. */
export async function ping(ex: Executor): Promise<void> {
  await ex.execute(sql`select 1`);
}
