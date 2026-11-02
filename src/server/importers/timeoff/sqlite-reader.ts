/**
 * Reads a TimeOff.Management SQLite file into plain {@link TimeOffSnapshot} records.
 *
 * Uses Node's built-in `node:sqlite` (unflagged since Node 22.13), opened **read-only**,
 * so the importer needs no native dependency and can never change the source file.
 *
 * TimeOff's tables come from Sequelize with default naming, which has varied between
 * versions (`companyId` vs `company_id`, `DepartmentId`), so every table and column is
 * looked up by a short list of known spellings, case-insensitively. A required table or
 * column that is missing stops the import with a message naming what the file has.
 * Columns added in later TimeOff versions (time zone, carry-over, accrual, auto-approve,
 * sort order) read as their TimeOff defaults when absent.
 *
 * This module only reads: no OOOhm database, services or configuration.
 */
import { DatabaseSync } from "node:sqlite";
import type { CalendarDate } from "@/domain/calendar-date";
import { DomainError } from "@/domain/errors";
import type {
  TimeOffAdjustment,
  TimeOffBankHoliday,
  TimeOffCompany,
  TimeOffDepartment,
  TimeOffLeave,
  TimeOffLeaveType,
  TimeOffSchedule,
  TimeOffSnapshot,
  TimeOffUser,
} from "@/domain/timeoff/source";

type Row = Record<string, unknown>;

const TABLES = {
  companies: ["Companies", "Company", "companies"],
  departments: ["Departments", "Department", "departments"],
  users: ["Users", "User", "users"],
  leaveTypes: ["LeaveTypes", "LeaveType", "leave_types"],
  leaves: ["Leaves", "Leave", "leaves"],
  bankHolidays: ["BankHolidays", "BankHoliday", "bank_holidays"],
  adjustments: ["user_allowance_adjustment", "UserAllowanceAdjustments", "user_allowance_adjustments"],
  schedules: ["schedule", "Schedules", "schedules"],
  supervisors: ["DepartmentSupervisor", "DepartmentSupervisors", "department_supervisor"],
} as const;

function fail(message: string): never {
  throw new DomainError("import_refused", message);
}

/** A table's rows with a lookup that accepts any of a column's known spellings. */
class Table {
  private readonly columns: Map<string, string>;

  constructor(
    readonly name: string,
    readonly rows: Row[],
    columnNames: string[],
  ) {
    this.columns = new Map(columnNames.map((c) => [c.toLowerCase(), c]));
  }

  column(names: readonly string[], required: boolean): string | undefined {
    for (const n of names) {
      const found = this.columns.get(n.toLowerCase());
      if (found) return found;
    }
    if (required) fail(`TimeOff table "${this.name}" has no column ${names.map((n) => `"${n}"`).join(" or ")}. It has: ${[...this.columns.values()].join(", ")}.`);
    return undefined;
  }

  /** Maps every row with accessors bound to the resolved columns. */
  map<T>(spec: Record<string, { names: readonly string[]; required?: boolean }>, build: (get: (field: string) => unknown) => T): T[] {
    const resolved = Object.fromEntries(Object.entries(spec).map(([field, s]) => [field, this.column(s.names, s.required ?? false)]));
    return this.rows.map((row) => build((field) => (resolved[field] === undefined ? undefined : row[resolved[field]!])));
  }
}

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function num(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function optionalId(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "string") return value === "1" || value.toLowerCase() === "true";
  return Number(value) !== 0;
}

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?\s*(Z|[+-]\d{2}:?\d{2})?$/;

/** A Sequelize SQLite timestamp (`2025-03-02 09:15:00.000 +00:00`) or epoch milliseconds, as an ISO string. */
export function parseTimeOffTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || typeof value === "bigint") {
    const d = new Date(Number(value));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const m = TIMESTAMP.exec(String(value).trim());
  if (!m) return null;
  const zone = m[3] === undefined || m[3] === "Z" ? "Z" : m[3].includes(":") ? m[3] : `${m[3].slice(0, 3)}:${m[3].slice(3)}`;
  const d = new Date(`${m[1]}T${m[2] ?? "00:00:00"}${zone}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * A TimeOff date as `YYYY-MM-DD`. TimeOff stores dates as date-times at UTC midnight and
 * reads them back in UTC, so the UTC calendar date is the stored one.
 */
export function parseTimeOffDate(value: unknown): CalendarDate | null {
  const iso = parseTimeOffTimestamp(value);
  return iso === null ? null : iso.slice(0, 10);
}

/**
 * Opens `path` read-only and reads every table the importer uses.
 *
 * @throws DomainError `import_refused` when the file is not a TimeOff database (a
 *   required table or column is missing); errors opening the file propagate as is.
 */
export function readTimeOffSqlite(path: string): TimeOffSnapshot {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tableNames = (db.prepare("select name from sqlite_master where type = 'table'").all() as Row[]).map((r) => str(r.name));
    const byLower = new Map(tableNames.map((n) => [n.toLowerCase(), n]));
    const load = (candidates: readonly string[], required: boolean): Table | undefined => {
      const name = candidates.map((c) => byLower.get(c.toLowerCase())).find((n) => n !== undefined);
      if (!name) {
        if (required) fail(`This does not look like a TimeOff.Management database: no table ${candidates.map((c) => `"${c}"`).join(" or ")}. Tables found: ${tableNames.join(", ") || "none"}.`);
        return undefined;
      }
      const quoted = `"${name.replaceAll('"', '""')}"`;
      const columns = (db.prepare(`pragma table_info(${quoted})`).all() as Row[]).map((r) => str(r.name));
      return new Table(name, db.prepare(`select * from ${quoted}`).all() as Row[], columns);
    };

    const companies = load(TABLES.companies, true)!.map(
      {
        id: { names: ["id"], required: true },
        name: { names: ["name"], required: true },
        country: { names: ["country"] },
        timezone: { names: ["timezone", "time_zone"] },
        startOfNewYear: { names: ["start_of_new_year"] },
        carryOver: { names: ["carry_over", "carryOver"] },
      },
      (get): TimeOffCompany => ({
        id: num(get("id"), 0),
        name: str(get("name")),
        country: get("country") == null ? null : str(get("country")),
        timezone: get("timezone") == null ? null : str(get("timezone")),
        startOfNewYear: optionalId(get("startOfNewYear")),
        carryOver: num(get("carryOver"), 0),
      }),
    );

    const departments = load(TABLES.departments, true)!.map(
      {
        id: { names: ["id"], required: true },
        name: { names: ["name"], required: true },
        allowance: { names: ["allowance", "allowence"], required: true },
        companyId: { names: ["companyId", "company_id", "CompanyId"], required: true },
        bossId: { names: ["bossId", "boss_id", "BossId"] },
        includePublicHolidays: { names: ["include_public_holidays"] },
        isAccruedAllowance: { names: ["is_accrued_allowance"] },
      },
      (get): TimeOffDepartment => ({
        id: num(get("id"), 0),
        companyId: num(get("companyId"), 0),
        name: str(get("name")),
        allowance: num(get("allowance"), 0),
        bossId: optionalId(get("bossId")),
        includePublicHolidays: bool(get("includePublicHolidays"), true),
        isAccruedAllowance: bool(get("isAccruedAllowance"), false),
      }),
    );

    const users = load(TABLES.users, true)!.map(
      {
        id: { names: ["id"], required: true },
        email: { names: ["email"], required: true },
        name: { names: ["name"], required: true },
        lastname: { names: ["lastname", "last_name"] },
        admin: { names: ["admin"] },
        activated: { names: ["activated"] },
        autoApprove: { names: ["auto_approve", "autoApprove"] },
        startDate: { names: ["start_date"] },
        endDate: { names: ["end_date"] },
        companyId: { names: ["companyId", "company_id", "CompanyId"], required: true },
        departmentId: { names: ["DepartmentId", "departmentId", "department_id"] },
        createdAt: { names: ["createdAt", "created_at"] },
      },
      (get): TimeOffUser => ({
        id: num(get("id"), 0),
        companyId: num(get("companyId"), 0),
        departmentId: optionalId(get("departmentId")),
        email: str(get("email")),
        name: str(get("name")),
        lastname: str(get("lastname")),
        admin: bool(get("admin"), false),
        activated: bool(get("activated"), true),
        autoApprove: bool(get("autoApprove"), false),
        startDate: parseTimeOffDate(get("startDate")),
        endDate: parseTimeOffDate(get("endDate")),
        createdAt: parseTimeOffTimestamp(get("createdAt")),
      }),
    );

    const leaveTypes = load(TABLES.leaveTypes, true)!.map(
      {
        id: { names: ["id"], required: true },
        name: { names: ["name"], required: true },
        color: { names: ["color", "colour"] },
        useAllowance: { names: ["use_allowance", "useAllowance"] },
        limit: { names: ["limit"] },
        sortOrder: { names: ["sort_order", "sortOrder"] },
        autoApprove: { names: ["auto_approve", "autoApprove"] },
        companyId: { names: ["companyId", "company_id", "CompanyId"], required: true },
      },
      (get): TimeOffLeaveType => ({
        id: num(get("id"), 0),
        companyId: num(get("companyId"), 0),
        name: str(get("name")),
        color: str(get("color")) || "#ffffff",
        useAllowance: bool(get("useAllowance"), true),
        limit: num(get("limit"), 0),
        sortOrder: num(get("sortOrder"), 0),
        autoApprove: bool(get("autoApprove"), false),
      }),
    );

    const leaves = load(TABLES.leaves, true)!.map(
      {
        id: { names: ["id"], required: true },
        status: { names: ["status"], required: true },
        dateStart: { names: ["date_start"], required: true },
        dateEnd: { names: ["date_end"], required: true },
        dayPartStart: { names: ["day_part_start"] },
        dayPartEnd: { names: ["day_part_end"] },
        employeeComment: { names: ["employee_comment"] },
        approverComment: { names: ["approver_comment"] },
        decidedAt: { names: ["decided_at"] },
        createdAt: { names: ["createdAt", "created_at"] },
        userId: { names: ["userId", "user_id", "UserId"], required: true },
        approverId: { names: ["approverId", "approver_id", "ApproverId"] },
        leaveTypeId: { names: ["leaveTypeId", "leave_type_id", "LeaveTypeId"], required: true },
      },
      (get): TimeOffLeave => ({
        id: num(get("id"), 0),
        userId: num(get("userId"), 0),
        approverId: optionalId(get("approverId")),
        leaveTypeId: num(get("leaveTypeId"), 0),
        status: num(get("status"), 0),
        dateStart: parseTimeOffDate(get("dateStart")) ?? "",
        dateEnd: parseTimeOffDate(get("dateEnd")) ?? "",
        dayPartStart: num(get("dayPartStart"), 1),
        dayPartEnd: num(get("dayPartEnd"), 1),
        employeeComment: get("employeeComment") == null ? null : str(get("employeeComment")),
        approverComment: get("approverComment") == null ? null : str(get("approverComment")),
        createdAt: parseTimeOffTimestamp(get("createdAt")),
        decidedAt: parseTimeOffTimestamp(get("decidedAt")),
      }),
    );

    const bankHolidays =
      load(TABLES.bankHolidays, false)?.map(
        {
          id: { names: ["id"], required: true },
          name: { names: ["name"] },
          date: { names: ["date"], required: true },
          companyId: { names: ["companyId", "company_id", "CompanyId"], required: true },
        },
        (get): TimeOffBankHoliday => ({
          id: num(get("id"), 0),
          companyId: num(get("companyId"), 0),
          name: str(get("name")),
          date: parseTimeOffDate(get("date")) ?? "",
        }),
      ) ?? [];

    const adjustments =
      load(TABLES.adjustments, false)?.map(
        {
          userId: { names: ["user_id", "userId", "UserId"], required: true },
          year: { names: ["year"], required: true },
          adjustment: { names: ["adjustment"] },
          carriedOver: { names: ["carried_over_allowance", "carriedOverAllowance"] },
        },
        (get): TimeOffAdjustment => ({
          userId: num(get("userId"), 0),
          year: num(get("year"), 0),
          adjustment: num(get("adjustment"), 0),
          carriedOverAllowance: num(get("carriedOver"), 0),
        }),
      ) ?? [];

    const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
    const schedules =
      load(TABLES.schedules, false)?.map(
        {
          companyId: { names: ["company_id", "companyId", "CompanyId"] },
          userId: { names: ["user_id", "userId", "UserId"] },
          ...Object.fromEntries(weekdays.map((d) => [d, { names: [d], required: true }])),
        },
        (get): TimeOffSchedule => ({
          companyId: optionalId(get("companyId")),
          userId: optionalId(get("userId")),
          days: weekdays.map((d) => num(get(d), 2)) as unknown as TimeOffSchedule["days"],
        }),
      ) ?? [];

    return {
      companies,
      departments,
      users,
      leaveTypes,
      leaves,
      bankHolidays,
      adjustments,
      schedules,
      departmentSupervisorLinks: load(TABLES.supervisors, false)?.rows.length ?? 0,
    };
  } finally {
    db.close();
  }
}
