import "server-only";
/**
 * The people module's own queries on `user` and `session`: the admin list, the manager
 * rules' reporting lines, whether an email is taken, a person's colour mode and signing
 * them out. The member reads and the person row other modules share are
 * `src/shared/lib/db/members.ts`.
 */
import { and, eq, ilike, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { departments, session, user } from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";
import type { ColorMode } from "@/shared/kernel/color-mode";
import type { PageRequest } from "@/shared/kernel/paging";
import { keysetPage } from "@/shared/lib/db/keyset";
import { notDeleted, personFields } from "@/shared/lib/db/members";

const manager = alias(user, "manager");

/** Which people the admin list shows. */
export interface PeopleFilter {
  /** Matched against name and email, case-insensitively, as a substring. */
  query?: string | undefined;
  status: "active" | "inactive" | "all";
  departmentId?: string | undefined;
  /** The page: after or before a `[lower(name), email]` key; the first when absent. */
  page?: PageRequest | undefined;
}

function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * A page of the company's people for the admin list, by name (then email, which is
 * unique, so the order is total), with department and manager names resolved in the
 * same query. Never tombstones. Each row carries its `sortName`, the key the database
 * sorted on: lowercasing in JS could differ from Postgres for some letters.
 */
export async function listPeople(ex: Executor, companyId: string, filter: PeopleFilter, limit: number) {
  const query = filter.query?.trim();
  const sortName = sql<string>`lower(${user.name})`;
  const page = keysetPage("asc", [sortName, user.email], filter.page, ([name, email]) => [sql`${name}`, sql`${email}`]);
  return ex
    .select({ ...personFields, sortName, departmentName: departments.name, managerName: manager.name, managerEmail: manager.email })
    .from(user)
    .leftJoin(departments, eq(departments.id, user.departmentId))
    .leftJoin(manager, eq(manager.id, user.managerId))
    .where(
      and(
        eq(user.companyId, companyId),
        notDeleted,
        filter.status === "all" ? undefined : eq(user.isActive, filter.status === "active"),
        filter.departmentId ? eq(user.departmentId, filter.departmentId) : undefined,
        query ? or(ilike(user.name, likePattern(query)), ilike(user.email, likePattern(query))) : undefined,
        page.where,
      ),
    )
    .orderBy(...page.orderBy)
    .limit(limit);
}

/** Every member's manager and active flag, for the manager rules. One query. */
export async function listReportingLines(ex: Executor, companyId: string) {
  return ex
    .select({ id: user.id, managerId: user.managerId, isActive: user.isActive, role: user.role })
    .from(user)
    .where(eq(user.companyId, companyId));
}

/**
 * Saves an active member's colour mode. @returns Whether they were found (an active, not
 * deleted member of the company).
 */
export async function updateColorMode(ex: Executor, companyId: string, userId: string, colorMode: ColorMode): Promise<boolean> {
  const rows = await ex
    .update(user)
    .set({ colorMode })
    .where(and(eq(user.id, userId), eq(user.companyId, companyId), eq(user.isActive, true), notDeleted))
    .returning({ id: user.id });
  return rows.length > 0;
}

/** Signs the person out everywhere: deletes every session. @returns How many there were. */
export async function deleteSessionsOf(tx: Transaction, userId: string): Promise<number> {
  const rows = await tx.delete(session).where(eq(session.userId, userId)).returning({ id: session.id });
  return rows.length;
}
