import { and, asc, eq, inArray } from "drizzle-orm";
import { user } from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";

const approvalFields = {
  id: user.id,
  role: user.role,
  canSelfApprove: user.canSelfApprove,
  managerId: user.managerId,
  isActive: user.isActive,
  createdAt: user.createdAt,
};

/**
 * Reads a company member and holds a row lock on them until the transaction ends.
 * Serialises concurrent submissions by the same person, so two overlapping requests
 * sent at once cannot both pass the overlap check.
 *
 * The lock is `FOR NO KEY UPDATE`, not `FOR UPDATE`: it still conflicts with itself,
 * but not with the `FOR KEY SHARE` lock Postgres takes when another transaction
 * inserts a row referencing this user (e.g. a request routed to them as approver).
 * `FOR UPDATE` would deadlock two people who approve each other submitting at once.
 */
export async function lockMember(tx: Transaction, companyId: string, userId: string) {
  const [row] = await tx
    .select(approvalFields)
    .from(user)
    .where(and(eq(user.id, userId), eq(user.companyId, companyId)))
    .for("no key update");
  return row;
}

export async function findMember(ex: Executor, companyId: string, userId: string) {
  const [row] = await ex
    .select(approvalFields)
    .from(user)
    .where(and(eq(user.id, userId), eq(user.companyId, companyId)));
  return row;
}

/** Active admins of a company, longest-standing first. */
export async function listActiveAdmins(ex: Executor, companyId: string) {
  return ex
    .select(approvalFields)
    .from(user)
    .where(and(eq(user.companyId, companyId), eq(user.role, "admin"), eq(user.isActive, true)))
    .orderBy(asc(user.createdAt), asc(user.id));
}

/** Name and email for notification recipients, limited to one company. */
export async function findContacts(ex: Executor, companyId: string, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return ex
    .select({ id: user.id, name: user.name, email: user.email, isActive: user.isActive })
    .from(user)
    .where(and(eq(user.companyId, companyId), inArray(user.id, [...ids])));
}
