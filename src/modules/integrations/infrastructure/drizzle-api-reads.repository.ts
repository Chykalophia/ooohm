import "server-only";
import { and, asc, eq, gt, isNull, ne, or } from "drizzle-orm";
import { departments, user } from "@/db/schema";
import type { Executor } from "@/db/types";
import type { Role } from "@/shared/kernel/actor";

/**
 * Read queries of the REST API (`/api/v1`). Each page is one query, keyset-paged on an
 * index, and every query is scoped by the API key's company. Pages fetch `limit + 1`
 * rows so the query can tell whether another page follows without counting.
 */

/** A person as the API shows them: no session, sign-in or approval-preference data. */
export type ApiUserRow = {
  id: string;
  name: string;
  email: string;
  role: Role;
  managerId: string | null;
  isActive: boolean;
  createdAt: Date;
  departmentId: string | null;
  departmentName: string | null;
};

/**
 * A page of the company's people by id, after `afterId`. Served by `user_company_id_idx`.
 * Deleted people are not listed: integrations learn of them from `user.deleted`.
 */
export async function listUsersPage(ex: Executor, input: { companyId: string; afterId?: string; limit: number }): Promise<ApiUserRow[]> {
  return ex
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      managerId: user.managerId,
      isActive: user.isActive,
      createdAt: user.createdAt,
      departmentId: user.departmentId,
      departmentName: departments.name,
    })
    .from(user)
    .leftJoin(departments, eq(departments.id, user.departmentId))
    .where(and(eq(user.companyId, input.companyId), isNull(user.deletedAt), input.afterId ? gt(user.id, input.afterId) : undefined))
    .orderBy(asc(user.id))
    .limit(input.limit + 1);
}

/**
 * The company's people for a balance listing: everyone active, or one person (active or
 * not, or deleted with their records kept). Never a scrubbed person, who has no balance
 * to report.
 */
export async function listBalanceSubjects(ex: Executor, companyId: string, userId?: string) {
  return ex
    .select({ id: user.id })
    .from(user)
    .where(
      and(
        eq(user.companyId, companyId),
        or(isNull(user.deletedAt), ne(user.deletionMode, "scrubbed")),
        userId ? eq(user.id, userId) : eq(user.isActive, true),
      ),
    )
    .orderBy(asc(user.id));
}
