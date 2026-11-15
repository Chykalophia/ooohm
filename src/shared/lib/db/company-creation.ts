import "server-only";
/**
 * Creating a company, shared by the first install (`src/server/identity/install.ts`) and
 * the TimeOff import, which may create the company it imports into.
 */
import { sql } from "drizzle-orm";
import { companies } from "@/db/schema";
import type { Transaction } from "@/db/types";
import { type CompanyRow, companyFields } from "@/shared/lib/db/company-columns";
import { returnedRow } from "@/db/rows";

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
  const rows = await tx.insert(companies).values(values).returning(companyFields);
  return returnedRow(rows);
}
