import "server-only";
import { companies } from "@/db/schema";

/**
 * How a company row is read: by the organisation module, which owns the table, and by
 * the setup and import code that creates the company (`insertCompany`).
 */

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
  /** Describe the logo, whose bytes only the organisation module's `getLogoFile` reads; read them through `readStoredLogo`. */
  logoSha256: string | null;
  logoType: string | null;
  logoWidth: number | null;
  logoHeight: number | null;
};
