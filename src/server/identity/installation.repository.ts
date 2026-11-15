import "server-only";
import { installation } from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";
import { isPopulated } from "@/shared/lib/db/pre-tenant";

/**
 * Whether this OOOhm has been set up: the install marker exists, or any company or person
 * does (a database seeded before the marker existed, or filled some other way). Any of
 * the three closes the web setup.
 */
export async function isInstalled(ex: Executor): Promise<boolean> {
  // One after another: the caller may pass a transaction, which runs one query at a time.
  if ((await ex.select({ id: installation.id }).from(installation).limit(1)).length > 0) return true;
  // Companies and people of any company: a pre-tenant read (ADR-0004).
  return isPopulated(ex);
}

/** Writes the install marker (once; a second call changes nothing). */
export async function markInstalled(tx: Transaction, method: "setup" | "seed"): Promise<void> {
  await tx.insert(installation).values({ method }).onConflictDoNothing();
}
