import "server-only";
import { eq } from "drizzle-orm";
import { companies } from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";
import { type CompanyRow, companyFields } from "@/shared/lib/db/company-columns";
import { returnedRow } from "@/db/rows";

export type { CompanyRow };

export async function findCompany(ex: Executor, companyId: string): Promise<CompanyRow | undefined> {
  const [row] = await ex.select(companyFields).from(companies).where(eq(companies.id, companyId));
  return row;
}

/**
 * Reads the company and holds a row lock on it until the transaction ends: the lock
 * `lockCompany` takes (`src/shared/lib/db/company-lock.ts`), for a caller that also needs
 * the company's settings.
 */
export async function lockAndFindCompany(tx: Transaction, companyId: string): Promise<CompanyRow | undefined> {
  const [row] = await tx.select(companyFields).from(companies).where(eq(companies.id, companyId)).for("no key update");
  return row;
}

export async function updateCompany(
  tx: Transaction,
  companyId: string,
  set: {
    name?: string;
    timezone?: string;
    workingDays?: number[];
    allowancePolicy?: string;
    deletionGrace?: boolean;
    managersSeeDetails?: boolean;
    approvalMode?: string;
    colleagueVisibility?: string;
    departmentScoping?: boolean;
    theme?: string;
    accentColor?: string | null;
    corners?: string;
    requestStyle?: string;
    layout?: string;
    /** Set with the four columns that describe it, or all five null. */
    logo?: Uint8Array | null;
    logoSha256?: string | null;
    logoType?: string | null;
    logoWidth?: number | null;
    logoHeight?: number | null;
  },
): Promise<CompanyRow> {
  const rows = await tx.update(companies).set(set).where(eq(companies.id, companyId)).returning(companyFields);
  return returnedRow(rows);
}

