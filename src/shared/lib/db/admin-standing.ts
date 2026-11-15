import "server-only";
import { and, eq } from "drizzle-orm";
import { user } from "@/db/schema";
import type { Executor } from "@/db/types";

/** A member's role and whether they are active, as `assertActiveAdmin` checks them; `undefined` outside the company. */
export async function findMemberStanding(ex: Executor, companyId: string, userId: string): Promise<{ role: string; isActive: boolean } | undefined> {
  const [row] = await ex
    .select({ role: user.role, isActive: user.isActive })
    .from(user)
    .where(and(eq(user.id, userId), eq(user.companyId, companyId)));
  return row;
}
