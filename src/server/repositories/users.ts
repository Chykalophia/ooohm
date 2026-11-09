import { and, asc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { departments, session, user } from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";
import type { Role } from "@/domain/actor";
import type { PageRequest } from "@/domain/paging";
import type { ColorMode } from "@/domain/color-mode";
import { keysetPage } from "./keyset";

const approvalFields = {
  id: user.id,
  role: user.role,
  canSelfApprove: user.canSelfApprove,
  managerId: user.managerId,
  departmentId: user.departmentId,
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
 *
 * A deleted person (a tombstone) is not a member: nothing may be written for them, so
 * they read as missing.
 */
export async function lockMember(tx: Transaction, companyId: string, userId: string) {
  const [row] = await tx
    .select(approvalFields)
    .from(user)
    .where(and(eq(user.id, userId), eq(user.companyId, companyId), isNull(user.deletedAt)))
    .for("no key update");
  return row;
}

/** Several members of a company at once, as {@link findMember} reads them. */
export async function findMembers(ex: Executor, companyId: string, userIds: readonly string[]) {
  if (userIds.length === 0) return [];
  return ex
    .select(approvalFields)
    .from(user)
    .where(and(eq(user.companyId, companyId), inArray(user.id, [...userIds])));
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

/** Active members of a company, oldest first. */
export async function listActiveMembers(ex: Executor, companyId: string) {
  return ex
    .select({ id: user.id, createdAt: user.createdAt })
    .from(user)
    .where(and(eq(user.companyId, companyId), eq(user.isActive, true)))
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

/** Everything the admin screens show and edit about a person. */
const personFields = {
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  departmentId: user.departmentId,
  managerId: user.managerId,
  canSelfApprove: user.canSelfApprove,
  isActive: user.isActive,
  createdAt: user.createdAt,
  scrubScheduledAt: user.scrubScheduledAt,
};

/** Not a tombstone: deleted people stay as rows (for their foreign keys) but are no longer people. */
const notDeleted = isNull(user.deletedAt);

export type PersonRow = {
  id: string;
  name: string;
  email: string;
  role: Role;
  departmentId: string | null;
  managerId: string | null;
  canSelfApprove: boolean;
  isActive: boolean;
  createdAt: Date;
  /** When a full scrub waiting out the company's grace period may run; `null` when none is scheduled. */
  scrubScheduledAt: Date | null;
};

const manager = alias(user, "manager");

/** Which people the admin list shows. */
export interface PeopleFilter {
  /** Matched against name and email, case-insensitively, as a substring. */
  query?: string;
  status: "active" | "inactive" | "all";
  departmentId?: string;
  /** The page: after or before a `[lower(name), email]` key; the first when absent. */
  page?: PageRequest;
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

/** One person of the company with every admin field, or `undefined` (also for a tombstone). */
export async function findPerson(ex: Executor, companyId: string, userId: string): Promise<PersonRow | undefined> {
  const [row] = await ex
    .select(personFields)
    .from(user)
    .where(and(eq(user.id, userId), eq(user.companyId, companyId), notDeleted));
  return row;
}

/** {@link findPerson}, holding the member lock (`FOR NO KEY UPDATE`, as {@link lockMember}) until commit. */
export async function lockPerson(tx: Transaction, companyId: string, userId: string): Promise<PersonRow | undefined> {
  const [row] = await tx
    .select(personFields)
    .from(user)
    .where(and(eq(user.id, userId), eq(user.companyId, companyId), notDeleted))
    .for("no key update");
  return row;
}

/** Every member's manager and active flag, for the manager rules. One query. */
export async function listReportingLines(ex: Executor, companyId: string) {
  return ex
    .select({ id: user.id, managerId: user.managerId, isActive: user.isActive, role: user.role })
    .from(user)
    .where(eq(user.companyId, companyId));
}

/**
 * Names of every member, active or not, by name: for pickers and for naming people in the
 * audit log. Tombstones (deleted people) are left out unless `includeDeleted`: a picker
 * never offers them, but history still names them ("Former employee #3f9a2c").
 */
export async function listPeopleNames(ex: Executor, companyId: string, options: { includeDeleted?: boolean } = {}) {
  return ex
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      isActive: user.isActive,
      role: user.role,
      deleted: sql<boolean>`${user.deletedAt} is not null`,
    })
    .from(user)
    .where(and(eq(user.companyId, companyId), options.includeDeleted ? undefined : notDeleted))
    .orderBy(asc(sql`lower(${user.name})`), asc(user.email));
}

/** Whether any account, in any company, uses `email` (already lowercased). */
export async function emailInUse(ex: Executor, email: string): Promise<boolean> {
  const [row] = await ex.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  return row !== undefined;
}

/** Of `emails` (already lowercased), those any account, in any company, uses. */
export async function emailsInUse(ex: Executor, emails: readonly string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const rows = await ex.select({ email: user.email }).from(user).where(inArray(user.email, [...emails]));
  return new Set(rows.map((r) => r.email));
}

export async function insertPerson(
  tx: Transaction,
  values: {
    id: string;
    companyId: string;
    email: string;
    name: string;
    role: Role;
    departmentId: string | null;
    managerId: string | null;
    canSelfApprove: boolean;
    /** Defaults to true (an admin's invite); an inbound sync may create people inactive. */
    isActive?: boolean;
  },
): Promise<PersonRow> {
  const [row] = await tx
    .insert(user)
    .values({ ...values, emailVerified: false, isActive: values.isActive ?? true })
    .returning(personFields);
  return row;
}

/** The account with this email (already lowercased), in any company, with its company. */
export async function findPersonByEmail(ex: Executor, email: string): Promise<(PersonRow & { companyId: string | null }) | undefined> {
  const [row] = await ex
    .select({ ...personFields, companyId: user.companyId })
    .from(user)
    .where(eq(user.email, email));
  return row;
}

export async function updatePerson(
  tx: Transaction,
  companyId: string,
  userId: string,
  set: Partial<Pick<PersonRow, "name" | "role" | "departmentId" | "managerId" | "canSelfApprove" | "isActive">>,
): Promise<PersonRow> {
  const [row] = await tx
    .update(user)
    .set(set)
    .where(and(eq(user.id, userId), eq(user.companyId, companyId)))
    .returning(personFields);
  return row;
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

/** How many people (active or not) are in a department. */
export async function countDepartmentMembers(ex: Executor, departmentId: string): Promise<number> {
  const [row] = await ex.select({ n: sql<number>`count(*)::int` }).from(user).where(eq(user.departmentId, departmentId));
  return row?.n ?? 0;
}

/**
 * A person by id alone, whatever their company, with what an `Actor` is built from:
 * for a link that names its person (the approve link in an email) and so carries no
 * session. Deleted people (tombstones) read as missing.
 */
export async function findActorById(ex: Executor, userId: string) {
  const [row] = await ex
    .select({ id: user.id, companyId: user.companyId, role: user.role, canSelfApprove: user.canSelfApprove, isActive: user.isActive })
    .from(user)
    .where(and(eq(user.id, userId), isNull(user.deletedAt)));
  return row;
}
