import "server-only";
import type { Executor } from "@/db/types";
import { findCompany as findCompanyRow } from "@/modules/organisation/infrastructure/drizzle-companies.repository";
import { type CompanyDTO, toCompanyDTO } from "@/modules/organisation/application/dto";

/**
 * The company's settings and appearance, or `undefined` when there is no such company:
 * how other services read the time zone, working days and the rest. Runs on the executor
 * it is given; the caller checks the actor.
 */
export async function findCompany(ex: Executor, companyId: string): Promise<CompanyDTO | undefined> {
  const row = await findCompanyRow(ex, companyId);
  return row && toCompanyDTO(row);
}
