import "server-only";
import { eq } from "drizzle-orm";
import { companies } from "@/db/schema";
import type { Transaction } from "@/db/types";

/**
 * The company row locks that serialise changes across a company. Every module takes them
 * inside its own transaction; a caller that also needs the company's settings reads them
 * through the organisation module (`lockCompanyForChange`), which takes the same lock.
 */

/**
 * Holds a row lock on the company until the transaction ends. Returns whether the company
 * exists.
 *
 * Admin changes whose rules span several people take it first: role and active
 * changes (so two admins cannot demote each other past the last-admin guard), manager
 * changes (so two edits cannot close a reporting loop between them), invites (so the
 * invite rate limit counts exactly), company settings, and holiday changes (which
 * recount submitted leave). `FOR NO KEY UPDATE` does not block rows that merely
 * reference the company.
 */
export async function lockCompany(tx: Transaction, companyId: string): Promise<boolean> {
  const [row] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("no key update");
  return row !== undefined;
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
