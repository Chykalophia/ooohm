import "server-only";
import type { Transaction } from "@/db/types";
import { updateCompany } from "@/modules/organisation/infrastructure/drizzle-companies.repository";
import { type CompanyDTO, toCompanyDTO } from "@/modules/organisation/application/dto";

/**
 * Writes company settings as given, in the caller's transaction, with no audit row or
 * event: for a process that records the change itself (the TimeOff import). Admin
 * changes go through the use cases, which validate and record.
 */
export async function applyCompanyChanges(
  tx: Transaction,
  companyId: string,
  set: Parameters<typeof updateCompany>[2],
): Promise<CompanyDTO> {
  return toCompanyDTO(await updateCompany(tx, companyId, set));
}
