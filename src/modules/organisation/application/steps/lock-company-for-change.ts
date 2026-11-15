import "server-only";
import type { Transaction } from "@/db/types";
import { lockAndFindCompany } from "@/modules/organisation/infrastructure/drizzle-companies.repository";
import { type CompanyDTO, toCompanyDTO } from "@/modules/organisation/application/dto";

/**
 * Takes the company lock (`lockCompany` in `src/shared/lib/db/company-lock.ts`) and
 * reads the company in the same query, for a change that also needs its settings (the
 * time zone, say). `undefined` when there is no such company. Runs in the caller's
 * transaction, which holds the lock until it ends.
 */
export async function lockCompanyForChange(tx: Transaction, companyId: string): Promise<CompanyDTO | undefined> {
  const row = await lockAndFindCompany(tx, companyId);
  return row && toCompanyDTO(row);
}
