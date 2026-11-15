import "server-only";

/** A level as pickers and other modules see it. */
export interface LevelDTO {
  id: string;
  name: string;
}

/** A level on the admin screen, with its head counts. */
export interface LevelSummaryDTO extends LevelDTO {
  /** Active people at the level (what the screen shows). */
  members: number;
  /** Everyone still at it, deactivated people included (what keeps it from being deleted). */
  assigned: number;
}

export function toLevelDTO({ id, name }: LevelDTO): LevelDTO {
  return { id, name };
}

export function toLevelSummaryDTO({ id, name, members, assigned }: LevelSummaryDTO): LevelSummaryDTO {
  return { id, name, members, assigned };
}

/**
 * The company's settings and appearance, as the admin screens and other modules read them.
 * Never the logo's bytes: those are read only by `getLogoFile`.
 */
export interface CompanyDTO {
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
  /** Describe the stored logo; read them through `readStoredLogo`. */
  logoSha256: string | null;
  logoType: string | null;
  logoWidth: number | null;
  logoHeight: number | null;
}

export function toCompanyDTO(c: CompanyDTO): CompanyDTO {
  return {
    id: c.id,
    name: c.name,
    timezone: c.timezone,
    workingDays: c.workingDays,
    allowancePolicy: c.allowancePolicy,
    deletionGrace: c.deletionGrace,
    managersSeeDetails: c.managersSeeDetails,
    approvalMode: c.approvalMode,
    colleagueVisibility: c.colleagueVisibility,
    departmentScoping: c.departmentScoping,
    theme: c.theme,
    accentColor: c.accentColor,
    corners: c.corners,
    requestStyle: c.requestStyle,
    layout: c.layout,
    logoSha256: c.logoSha256,
    logoType: c.logoType,
    logoWidth: c.logoWidth,
    logoHeight: c.logoHeight,
  };
}

/** The Company screen: the settings, and the choices its form offers. */
export interface CompanySettingsFormDTO {
  company: CompanyDTO;
  /** Every supported time zone, plus the stored one should it be an alias outside that list, sorted. */
  timeZones: string[];
  /** Every registered allowance policy. */
  allowancePolicies: string[];
}

/** A department as pickers and other modules see it. */
export interface DepartmentDTO {
  id: string;
  name: string;
  managerId: string | null;
  /** The optional coverage limit: at most this many of its people off at once. */
  maxOff: number | null;
}

export function toDepartmentDTO({ id, name, managerId, maxOff }: DepartmentDTO): DepartmentDTO {
  return { id, name, managerId, maxOff };
}

/** A department on the admin screen, with its manager's label and its head counts. */
export interface DepartmentSummaryDTO extends DepartmentDTO {
  /** The manager's name (or email) for its label; null with no manager. */
  managerName: string | null;
  /** Active people in it (what the screen shows). */
  members: number;
  /** Everyone still in it, deactivated people included (what keeps it from being deleted). */
  assigned: number;
}

export function toDepartmentSummaryDTO(d: DepartmentSummaryDTO): DepartmentSummaryDTO {
  return { ...toDepartmentDTO(d), managerName: d.managerName, members: d.members, assigned: d.assigned };
}

/** Someone the department manager picker offers. */
export interface DepartmentManagerChoiceDTO {
  id: string;
  label: string;
}

/** A leave type as other modules name it: on requests, calendars and approvals. */
export interface LeaveTypeDTO {
  id: string;
  name: string;
  code: string;
  color: string;
}

export function toLeaveTypeDTO({ id, name, code, color }: LeaveTypeDTO): LeaveTypeDTO {
  return { id, name, code, color };
}

/**
 * A leave type with every setting, as the admin screens edit it and the API lists it.
 *
 * `defaultAllowanceDays` is the type's own setting. A person's default allowance can
 * differ (an allowance rule for their department or level replaces it), so balances read
 * it only through `loadAllowanceDefaults`, never from here.
 */
export interface LeaveTypeSettingsDTO extends LeaveTypeDTO {
  countsAgainstAllowance: boolean;
  defaultAllowanceDays: number | null;
  carryoverEnabled: boolean;
  carryoverMaxDays: number | null;
  isPaid: boolean;
  sortOrder: number;
  archivedAt: Date | null;
}

export function toLeaveTypeSettingsDTO(t: LeaveTypeSettingsDTO): LeaveTypeSettingsDTO {
  return {
    ...toLeaveTypeDTO(t),
    countsAgainstAllowance: t.countsAgainstAllowance,
    defaultAllowanceDays: t.defaultAllowanceDays,
    carryoverEnabled: t.carryoverEnabled,
    carryoverMaxDays: t.carryoverMaxDays,
    isPaid: t.isPaid,
    sortOrder: t.sortOrder,
    archivedAt: t.archivedAt,
  };
}

/** What an allowance rule's audit row and event record about it. */
export interface AllowanceRuleFacts {
  id: string;
  leaveTypeId: string;
  departmentId: string | null;
  levelId: string | null;
  days: number;
}

/** The settings a leave type is written with: everything but its id, position and archived state. */
export type LeaveTypeFields = Omit<LeaveTypeSettingsDTO, "id" | "archivedAt" | "sortOrder">;
