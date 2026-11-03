import { asc, eq } from "drizzle-orm";
import { companies } from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";

const companyFields = {
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
  layout: companies.layout,
};

export type CompanyRow = {
  id: string;
  name: string;
  timezone: string;
  workingDays: number[];
  allowancePolicy: string;
  /** Full-scrub deletes wait 7 days, with undo. */
  deletionGrace: boolean;
  /** Raw stored appearance; read it through `readAppearance`. */
  theme: string;
  accentColor: string | null;
  corners: string;
  requestStyle: string;
  layout: string;
};

export async function findCompany(ex: Executor, companyId: string): Promise<CompanyRow | undefined> {
  const [row] = await ex.select(companyFields).from(companies).where(eq(companies.id, companyId));
  return row;
}

/**
 * Reads the company and holds a row lock on it until the transaction ends.
 *
 * Admin changes whose rules span several people take it first: role and active
 * changes (so two admins cannot demote each other past the last-admin guard), manager
 * changes (so two edits cannot close a reporting loop between them), invites (so the
 * invite rate limit counts exactly) and company settings. `FOR NO KEY UPDATE` does not
 * block rows that merely reference the company.
 */
export async function lockCompany(tx: Transaction, companyId: string): Promise<CompanyRow | undefined> {
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
    theme?: string;
    accentColor?: string | null;
    corners?: string;
    requestStyle?: string;
    layout?: string;
  },
): Promise<CompanyRow> {
  const [row] = await tx.update(companies).set(set).where(eq(companies.id, companyId)).returning(companyFields);
  return row;
}

/**
 * The appearance of the deployment's company, for pages that render before anyone is
 * known (the sign-in page) as well as after. v1 runs one company per deployment; with
 * several, the oldest one's look applies.
 */
export async function findDeploymentAppearance(
  ex: Executor,
): Promise<{ theme: string; accentColor: string | null; corners: string; requestStyle: string; layout: string } | undefined> {
  const [row] = await ex
    .select({
      theme: companies.theme,
      accentColor: companies.accentColor,
      corners: companies.corners,
      requestStyle: companies.requestStyle,
      layout: companies.layout,
    })
    .from(companies)
    .orderBy(asc(companies.createdAt), asc(companies.id))
    .limit(1);
  return row;
}
