import "server-only";
import { asc, eq } from "drizzle-orm";
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

/** A stored logo's bytes and type, found by the SHA-256 that names it. */
export async function findLogoFile(ex: Executor, sha256: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
  const [row] = await ex
    .select({ bytes: companies.logo, contentType: companies.logoType })
    .from(companies)
    .where(eq(companies.logoSha256, sha256))
    .limit(1);
  return row?.bytes && row.contentType ? { bytes: row.bytes, contentType: row.contentType } : undefined;
}

/** The deployment's company (the oldest, as in {@link findDeploymentAppearance}): its name and logo description. */
export async function findDeploymentBrand(
  ex: Executor,
): Promise<Pick<CompanyRow, "name" | "logoSha256" | "logoType" | "logoWidth" | "logoHeight"> | undefined> {
  const [row] = await ex
    .select({
      name: companies.name,
      logoSha256: companies.logoSha256,
      logoType: companies.logoType,
      logoWidth: companies.logoWidth,
      logoHeight: companies.logoHeight,
    })
    .from(companies)
    .orderBy(asc(companies.createdAt), asc(companies.id))
    .limit(1);
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
