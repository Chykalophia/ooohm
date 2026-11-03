/**
 * Queries for one-time imports (TimeOff.Management): the `import_runs` ledger, the
 * checks that a target company is empty enough, and bulk writes. An import writes
 * thousands of rows in one transaction, so the writes here insert in chunks instead of
 * one statement per row.
 */
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { allowances, auditLog, companies, departments, importRuns, leaveRequestDays, leaveRequests, user } from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";
import type { Role } from "@/domain/actor";
import type { ChangeSource } from "@/domain/change-source";
import { type AuditEntry, sourceColumns } from "./change-log";
import type { CompanyRow } from "./companies";

/** Rows per insert statement: well under Postgres's 65,535 bind parameters for the widest table here. */
const CHUNK = 500;

function chunks<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
}

export type ImportRunRow = typeof importRuns.$inferSelect;

/** The applied import of the file with this SHA-256, if any. */
export async function findImportRunBySha(ex: Executor, sourceSha256: string): Promise<ImportRunRow | undefined> {
  const [row] = await ex.select().from(importRuns).where(eq(importRuns.sourceSha256, sourceSha256));
  return row;
}

/** The earliest applied import from `source` (e.g. `timeoff`) into this company, if any. */
export async function findImportRunByCompany(ex: Executor, companyId: string, source: string): Promise<ImportRunRow | undefined> {
  const [row] = await ex
    .select()
    .from(importRuns)
    .where(and(eq(importRuns.companyId, companyId), eq(importRuns.source, source)))
    .orderBy(asc(importRuns.createdAt))
    .limit(1);
  return row;
}

export async function insertImportRun(
  tx: Transaction,
  values: { companyId: string; source: string; sourceSha256: string; sourceFileName: string; counts: unknown; report: unknown },
): Promise<ImportRunRow> {
  const [row] = await tx.insert(importRuns).values(values).returning();
  return row;
}

/** Every company, so a refusal for an unknown company can list the ones that exist. */
export async function listCompanyNames(ex: Executor) {
  return ex.select({ id: companies.id, name: companies.name }).from(companies).orderBy(companies.createdAt);
}

/**
 * Locks the companies table against inserts (and against another caller of this) until
 * the transaction ends, so a check that no company exists still holds when one is created.
 */
export async function lockCompaniesTable(tx: Transaction): Promise<void> {
  await tx.execute(sql`LOCK TABLE ${companies} IN SHARE ROW EXCLUSIVE MODE`);
}

export async function insertCompany(
  tx: Transaction,
  values: { name: string; timezone: string; workingDays: number[] },
): Promise<CompanyRow> {
  const [row] = await tx.insert(companies).values(values).returning({
    id: companies.id,
    name: companies.name,
    timezone: companies.timezone,
    workingDays: companies.workingDays,
    allowancePolicy: companies.allowancePolicy,
    deletionGrace: companies.deletionGrace,
    theme: companies.theme,
    accentColor: companies.accentColor,
    corners: companies.corners,
    requestStyle: companies.requestStyle,
  });
  return row;
}

/** How many leave requests a company holds, in any status. */
export async function countCompanyLeaveRequests(ex: Executor, companyId: string): Promise<number> {
  const [row] = await ex.select({ n: count() }).from(leaveRequests).where(eq(leaveRequests.companyId, companyId));
  return row?.n ?? 0;
}

/** Leave requests per leave type of a company, for types the import may archive. */
export async function countRequestsByLeaveType(ex: Executor, companyId: string): Promise<Map<string, number>> {
  const rows = await ex
    .select({ leaveTypeId: leaveRequests.leaveTypeId, n: count() })
    .from(leaveRequests)
    .where(eq(leaveRequests.companyId, companyId))
    .groupBy(leaveRequests.leaveTypeId);
  return new Map(rows.map((r) => [r.leaveTypeId, r.n]));
}

/** An account as the importer matches it: by email, in any company. */
export interface ExistingAccount {
  id: string;
  email: string;
  name: string;
  companyId: string | null;
  role: Role;
  departmentId: string | null;
  managerId: string | null;
  canSelfApprove: boolean;
  isActive: boolean;
}

const accountFields = {
  id: user.id,
  email: user.email,
  name: user.name,
  companyId: user.companyId,
  role: user.role,
  departmentId: user.departmentId,
  managerId: user.managerId,
  canSelfApprove: user.canSelfApprove,
  isActive: user.isActive,
};

/** Accounts with any of these (lowercased) emails, in any company. One query. */
export async function findAccountsByEmail(ex: Executor, emails: readonly string[]): Promise<ExistingAccount[]> {
  if (emails.length === 0) return [];
  const out: ExistingAccount[] = [];
  for (const part of chunks(emails)) out.push(...(await ex.select(accountFields).from(user).where(inArray(user.email, part))));
  return out;
}

/** Every member of a company, active or not. */
export async function listCompanyAccounts(ex: Executor, companyId: string): Promise<ExistingAccount[]> {
  return ex.select(accountFields).from(user).where(eq(user.companyId, companyId));
}

/** A company's departments by lowercased name. */
export async function listDepartmentsByName(ex: Executor, companyId: string): Promise<Map<string, { id: string; name: string }>> {
  const rows = await ex.select({ id: departments.id, name: departments.name }).from(departments).where(eq(departments.companyId, companyId));
  return new Map(rows.map((r) => [r.name.toLowerCase(), r]));
}

export type NewImportedAccount = {
  id: string;
  companyId: string;
  email: string;
  name: string;
  role: Role;
  departmentId: string | null;
  canSelfApprove: boolean;
  isActive: boolean;
  createdAt: Date;
};

/**
 * Creates accounts with no manager yet (managers are set once everyone exists). Nothing
 * else: no session, account link or verification token, so nobody can sign in until
 * they ask for a magic link like any invited person.
 */
export async function insertImportedAccounts(tx: Transaction, rows: readonly NewImportedAccount[]): Promise<void> {
  for (const part of chunks(rows)) {
    await tx.insert(user).values(part.map((r) => ({ ...r, emailVerified: false, updatedAt: r.createdAt })));
  }
}

/** Updates the fields an import sets on one account of the company. */
export async function updateImportedAccount(
  tx: Transaction,
  companyId: string,
  id: string,
  set: Partial<Pick<ExistingAccount, "name" | "role" | "departmentId" | "managerId" | "canSelfApprove">>,
): Promise<void> {
  await tx
    .update(user)
    .set(set)
    .where(and(eq(user.id, id), eq(user.companyId, companyId)));
}

export type ImportedAllowance = typeof allowances.$inferSelect;

/**
 * Writes allowance rows, replacing `days`, `carried_over_days` and `adjustment_days` of
 * any row the person already has for that type and year.
 *
 * @returns The rows as written.
 */
export async function upsertAllowances(
  tx: Transaction,
  rows: readonly { userId: string; leaveTypeId: string; year: number; days: number; carriedOverDays: number; adjustmentDays: number }[],
): Promise<ImportedAllowance[]> {
  const out: ImportedAllowance[] = [];
  for (const part of chunks(rows)) {
    out.push(
      ...(await tx
        .insert(allowances)
        .values([...part])
        .onConflictDoUpdate({
          target: [allowances.userId, allowances.leaveTypeId, allowances.year],
          set: {
            days: sql`excluded.days`,
            carriedOverDays: sql`excluded.carried_over_days`,
            adjustmentDays: sql`excluded.adjustment_days`,
          },
        })
        .returning()),
    );
  }
  return out;
}

/** Allowance rows of these people for one leave type, before the import overwrites any. */
export async function listAllowancesOf(ex: Executor, userIds: readonly string[], leaveTypeId: string): Promise<ImportedAllowance[]> {
  if (userIds.length === 0) return [];
  const out: ImportedAllowance[] = [];
  for (const part of chunks(userIds)) {
    out.push(...(await ex.select().from(allowances).where(and(inArray(allowances.userId, part), eq(allowances.leaveTypeId, leaveTypeId)))));
  }
  return out;
}

export type NewImportedRequest = typeof leaveRequests.$inferInsert & { id: string };

/** Inserts leave requests with their per-year split; every split entry must have `days > 0`. */
export async function insertImportedRequests(
  tx: Transaction,
  rows: readonly { request: NewImportedRequest; split: readonly { year: number; days: number }[] }[],
): Promise<void> {
  for (const part of chunks(rows)) {
    await tx.insert(leaveRequests).values(part.map((r) => r.request));
    await tx
      .insert(leaveRequestDays)
      .values(part.flatMap((r) => r.split.map((s) => ({ requestId: r.request.id, year: s.year, days: s.days }))));
  }
}

/**
 * Writes many audit rows at once, every one attributed to `source`. Like `recordChange`,
 * it takes a `Transaction`, so the rows commit or roll back with the changes they
 * describe, and a required source, so none is anonymous; unlike it, it writes no outbox
 * event (an import announces itself with one `import.completed`).
 */
export async function insertAuditEntries(tx: Transaction, source: ChangeSource, entries: readonly AuditEntry[]): Promise<void> {
  const columns = sourceColumns(source);
  for (const part of chunks(entries)) await tx.insert(auditLog).values(part.map((e) => ({ ...e, ...columns })));
}
