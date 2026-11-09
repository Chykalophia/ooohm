import { asc, eq } from "drizzle-orm";
import { companies } from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";

/** The columns of a {@link CompanyRow}; never the logo's bytes. */
export const companyFields = {
  id: companies.id,
  name: companies.name,
  timezone: companies.timezone,
  workingDays: companies.workingDays,
  allowancePolicy: companies.allowancePolicy,
  deletionGrace: companies.deletionGrace,
  managersSeeDetails: companies.managersSeeDetails,
  approvalMode: companies.approvalMode,
  colleagueVisibility: companies.colleagueVisibility,
  departmentScoping: companies.departmentScoping,
  theme: companies.theme,
  accentColor: companies.accentColor,
  corners: companies.corners,
  requestStyle: companies.requestStyle,
  layout: companies.layout,
  logoSha256: companies.logoSha256,
  logoType: companies.logoType,
  logoWidth: companies.logoWidth,
  logoHeight: companies.logoHeight,
};

export type CompanyRow = {
  id: string;
  name: string;
  timezone: string;
  workingDays: number[];
  allowancePolicy: string;
  /** Full-scrub deletes wait 7 days, with undo. */
  deletionGrace: boolean;
  /** Managers see their direct reports' balances and notes on the team member page. */
  managersSeeDetails: boolean;
  /** Raw stored approval mode; read it through `readApprovalMode`. */
  approvalMode: string;
  /** What employees see of colleagues' time off; read it through `readColleagueVisibility`. */
  colleagueVisibility: string;
  /** Everyone but admins sees only their departments' time off (`calendarScopeFor`). */
  departmentScoping: boolean;
  /** Raw stored appearance; read it through `readAppearance`. */
  theme: string;
  accentColor: string | null;
  corners: string;
  requestStyle: string;
  layout: string;
  /** Describe the logo, whose bytes are read only by {@link findLogoFile}; read them through `readStoredLogo`. */
  logoSha256: string | null;
  logoType: string | null;
  logoWidth: number | null;
  logoHeight: number | null;
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
  const [row] = await tx.update(companies).set(set).where(eq(companies.id, companyId)).returning(companyFields);
  return row;
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
