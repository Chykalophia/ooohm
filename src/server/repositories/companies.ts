import { eq } from "drizzle-orm";
import { companies } from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";

const companyFields = {
  id: companies.id,
  name: companies.name,
  timezone: companies.timezone,
  workingDays: companies.workingDays,
  allowancePolicy: companies.allowancePolicy,
  deletionGrace: companies.deletionGrace,
};

export type CompanyRow = {
  id: string;
  name: string;
  timezone: string;
  workingDays: number[];
  allowancePolicy: string;
  /** Full-scrub deletes wait 7 days, with undo. */
  deletionGrace: boolean;
};

export async function findCompany(ex: Executor, companyId: string): Promise<CompanyRow | undefined> {
  const [row] = await ex.select(companyFields).from(companies).where(eq(companies.id, companyId));
  return row;
}

/**
 * Takes a shared lock on the company row (`FOR SHARE`) for the rest of `tx`. Any number
 * of shared holders run side by side, but {@link lockCompany} waits for them, and they
 * for it. Leave submits hold it while counting days, so a holiday or working-days
 * change, which recounts submitted requests under {@link lockCompany}, can never miss a
 * request counted with the old calendar.
 */
export async function shareLockCompany(tx: Transaction, companyId: string): Promise<void> {
  await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("share");
}

/**
 * Reads the company and holds a row lock on it until the transaction ends.
 *
 * Admin changes whose rules span several people take it first: role and active
 * changes (so two admins cannot demote each other past the last-admin guard), manager
 * changes (so two edits cannot close a reporting loop between them), invites (so the
 * invite rate limit counts exactly), company settings, and holiday changes (which
 * recount submitted leave). `FOR NO KEY UPDATE` does not block rows that merely
 * reference the company.
 */
export async function lockCompany(tx: Transaction, companyId: string): Promise<CompanyRow | undefined> {
  const [row] = await tx.select(companyFields).from(companies).where(eq(companies.id, companyId)).for("no key update");
  return row;
}

export async function updateCompany(
  tx: Transaction,
  companyId: string,
  set: { name: string; timezone: string; workingDays: number[]; allowancePolicy: string; deletionGrace?: boolean },
): Promise<CompanyRow> {
  const [row] = await tx.update(companies).set(set).where(eq(companies.id, companyId)).returning(companyFields);
  return row;
}
