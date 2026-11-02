/**
 * Builds a synthetic TimeOff.Management SQLite database at test time (no binary is
 * committed), laid out as TimeOff's Sequelize models create it: pluralized tables,
 * camelCase foreign keys (`companyId`, `DepartmentId`, `userId`), snake_case fields,
 * dates as `YYYY-MM-DD HH:MM:SS.SSS +00:00` text.
 *
 * The default data is one company over 2025 and 2026 with the edge cases the importer
 * must handle, and is self-consistent: each person's 2026 carried-over allowance is what
 * TimeOff's carry-over (company `carry_over` = 5) gives from their 2025 balance, so an
 * import reconciles to zero difference. Expected TimeOff balances are listed in
 * {@link FIXTURE_EXPECTED_2026}. Nina never signed in to TimeOff (`activated` 0) and
 * Quinn starts next year; both are current employees. Tests change the data through `mutate`.
 */
import { DatabaseSync } from "node:sqlite";

export interface FixtureData {
  companies: Record<string, unknown>[];
  departments: Record<string, unknown>[];
  users: Record<string, unknown>[];
  leaveTypes: Record<string, unknown>[];
  leaves: Record<string, unknown>[];
  bankHolidays: Record<string, unknown>[];
  adjustments: Record<string, unknown>[];
  schedules: Record<string, unknown>[];
  supervisors: Record<string, unknown>[];
}

const at = (date: string, time = "00:00:00.000") => `${date} ${time} +00:00`;

/** TimeOff user ids in the default data. */
export const U = {
  alice: 1,
  bob: 2,
  olivia: 3,
  carol: 4,
  dave: 5,
  erin: 6,
  frank: 7,
  gina: 8,
  henry: 9,
  henryDuplicate: 10,
  ivan: 11,
  paula: 12,
  nina: 13,
  quinn: 14,
} as const;

/** TimeOff leave type ids. */
export const T = { holiday: 1, training: 2, sick: 3, jury: 4 } as const;

/** TimeOff's 2026 remaining (total − approved days) per email, worked out by hand in the comments below. */
export const FIXTURE_EXPECTED_2026: Readonly<Record<string, number>> = {
  "alice@example.com": 20, // Ops 20 + carried 5 − 5 (Mar 9-13)
  "bob@example.com": 25, // Eng 25 + 5 − 5 (Training Jun 15-19, merged into the pool; Sick not counted)
  "olivia@example.com": 25, // Ops 20 + 5 − 0 (3 pending days are not subtracted by TimeOff)
  "carol@example.com": 25, // Eng 25 + adjustment 2 + carried 3 − 5
  "dave@example.com": 27.5, // Eng 25 + 5 − 0.5 (Feb 16 am) − 2 (Mar 2 pm .. Mar 4 am)
  "erin@example.com": 23, // Ops 20 + 5 − 2 (Jan 2 and Jan 5; Jan 1 is a holiday)
  "frank@example.com": 25, // Eng 25 + 5 − 3 (May 21-26 over a weekend and Memorial Day) − 2 (pended revoke)
  "henry@example.com": 27, // Eng 25 + 5 − 3 (Training)
  "ivan@example.com": 17, // Ops 20 pro-rated from Mar 1: round(20 × 305 / 365) = 17; Jury Duty not counted
  "paula@example.com": 26, // Eng 25 + 5 − 4 (Mon-Thu, her own schedule)
  "nina@example.com": 25, // Ops 20 + 5; never signed in to TimeOff, still employed
  "quinn@example.com": 0, // starts 2027-01-04: TimeOff shows nothing before the start year
};

/** TimeOff's 2027 remaining for Quinn, the future hire: Ops 20 pro-rated from Jan 4, round(20 × 361 / 365) = 20. */
export const FIXTURE_QUINN_2027 = 20;

function defaults(): FixtureData {
  const user = (id: number, email: string, name: string, lastname: string, departmentId: number | null, extra: Record<string, unknown> = {}) => ({
    id,
    email,
    password: "x",
    name,
    lastname,
    activated: 1,
    admin: 0,
    auto_approve: 0,
    start_date: at("2020-01-06"),
    end_date: null,
    createdAt: at("2020-01-06", "09:00:00.000"),
    updatedAt: at("2020-01-06", "09:00:00.000"),
    companyId: 1,
    DepartmentId: departmentId,
    ...extra,
  });
  let leaveId = 0;
  const leave = (
    userId: number,
    leaveTypeId: number,
    start: string,
    end: string,
    status: number,
    extra: Record<string, unknown> = {},
  ) => ({
    id: ++leaveId,
    status,
    employee_comment: null,
    approver_comment: null,
    decided_at: status === 1 ? null : at(start, "08:00:00.000"),
    date_start: at(start),
    day_part_start: 1,
    date_end: at(end),
    day_part_end: 1,
    createdAt: at(start, "07:00:00.000"),
    updatedAt: at(start, "07:00:00.000"),
    userId,
    approverId: U.alice,
    leaveTypeId,
    ...extra,
  });
  const adj = (userId: number, year: number, adjustment: number, carried: number) => ({
    year,
    adjustment,
    carried_over_allowance: carried,
    created_at: at(`${year}-01-01`),
    user_id: userId,
  });
  const ENG = 1;
  const OPS = 2;
  return {
    companies: [
      {
        id: 1,
        name: "Chykalophia Test",
        country: "US",
        start_of_new_year: 1,
        share_all_absences: 0,
        timezone: "America/Chicago",
        carry_over: 5,
        mode: 1,
        date_format: "YYYY-MM-DD",
        createdAt: at("2019-01-01"),
        updatedAt: at("2019-01-01"),
      },
    ],
    departments: [
      { id: ENG, name: "Engineering", allowance: 25, include_public_holidays: 1, is_accrued_allowance: 0, companyId: 1, bossId: U.bob },
      { id: OPS, name: "Operations", allowance: 20, include_public_holidays: 1, is_accrued_allowance: 0, companyId: 1, bossId: U.olivia },
    ],
    users: [
      user(U.alice, "alice@example.com", "Alice", "Admin", OPS, { admin: 1, auto_approve: 1 }),
      user(U.bob, "bob@example.com", "Bob", "Boss", ENG, { start_date: at("2021-03-01") }),
      user(U.olivia, "olivia@example.com", "Olivia", "Ops", OPS, { start_date: at("2019-05-01") }),
      user(U.carol, "carol@example.com", "Carol", "Carry", ENG, { start_date: at("2022-01-10") }),
      user(U.dave, "dave@example.com", "Dave", "Halves", ENG, { start_date: at("2023-02-01") }),
      user(U.erin, "erin@example.com", "Erin", "NewYear", OPS),
      user(U.frank, "frank@example.com", "Frank", "Holiday", ENG),
      user(U.gina, "gina@example.com", "Gina", "Gone", OPS, { start_date: at("2018-01-08"), end_date: at("2025-06-30") }),
      user(U.henry, "henry@example.com", "Henry", "Kept", ENG, { start_date: at("2022-06-01") }),
      user(U.henryDuplicate, "Henry@Example.COM", "Henry", "Old", ENG, { start_date: at("2019-01-07"), end_date: at("2024-12-31") }),
      user(U.ivan, "ivan@example.com", "Ivan", "New", OPS, { start_date: at("2026-03-01"), createdAt: at("2026-02-20") }),
      user(U.paula, "paula@example.com", "Paula", "PartTime", ENG, { start_date: at("2024-01-08") }),
      user(U.nina, "nina@example.com", "Nina", "Pending", OPS, { activated: 0 }),
      user(U.quinn, "quinn@example.com", "Quinn", "Future", OPS, { activated: 0, start_date: at("2027-01-04"), createdAt: at("2026-10-20") }),
    ],
    leaveTypes: [
      { id: T.holiday, name: "Holiday", color: "#22aa88", use_allowance: 1, limit: 0, sort_order: 0, auto_approve: 0, companyId: 1 },
      { id: T.training, name: "Training", color: "#3366cc", use_allowance: 1, limit: 0, sort_order: 1, auto_approve: 0, companyId: 1 },
      { id: T.sick, name: "Sick Leave", color: "leave_type_color_3", use_allowance: 0, limit: 0, sort_order: 2, auto_approve: 0, companyId: 1 },
      { id: T.jury, name: "Jury Duty", color: "#7c3aed", use_allowance: 0, limit: 5, sort_order: 3, auto_approve: 0, companyId: 1 },
    ],
    leaves: [
      leave(U.alice, T.holiday, "2025-08-04", "2025-08-08", 2, { employee_comment: "Summer trip" }),
      leave(U.alice, T.holiday, "2026-03-09", "2026-03-13", 2),
      leave(U.bob, T.holiday, "2025-10-06", "2025-10-07", 2),
      leave(U.bob, T.training, "2026-06-15", "2026-06-19", 2, { employee_comment: "Conference" }),
      leave(U.bob, T.sick, "2026-09-07", "2026-09-07", 2),
      leave(U.olivia, T.holiday, "2026-11-23", "2026-11-25", 1),
      leave(U.olivia, T.holiday, "2026-02-02", "2026-02-03", 3, { approver_comment: "Launch week" }),
      leave(U.carol, T.holiday, "2025-03-03", "2025-03-07", 2),
      leave(U.carol, T.holiday, "2025-04-14", "2025-04-15", 2),
      leave(U.carol, T.holiday, "2026-04-06", "2026-04-10", 2),
      leave(U.dave, T.holiday, "2026-02-16", "2026-02-16", 2, { day_part_start: 2, day_part_end: 2 }),
      leave(U.dave, T.holiday, "2026-03-02", "2026-03-04", 2, { day_part_start: 3, day_part_end: 2 }),
      leave(U.dave, T.holiday, "2026-07-06", "2026-07-07", 5),
      leave(U.erin, T.holiday, "2025-12-29", "2026-01-05", 2),
      leave(U.frank, T.holiday, "2026-05-21", "2026-05-26", 2),
      leave(U.frank, T.holiday, "2026-08-10", "2026-08-11", 4),
      leave(U.gina, T.holiday, "2025-02-10", "2025-02-11", 2),
      leave(U.henry, T.training, "2026-01-12", "2026-01-14", 2),
      leave(U.henryDuplicate, T.holiday, "2024-05-06", "2024-05-06", 2),
      leave(U.ivan, T.jury, "2026-04-20", "2026-04-20", 2),
      leave(U.ivan, T.holiday, "2026-06-01", "2026-06-02", 1),
      leave(U.paula, T.holiday, "2026-03-16", "2026-03-19", 2),
    ],
    bankHolidays: [
      { id: 1, name: "Independence Day (observed)", date: at("2025-07-04"), companyId: 1 },
      { id: 2, name: "Christmas Day", date: at("2025-12-25"), companyId: 1 },
      { id: 3, name: "New Year's Day", date: at("2026-01-01"), companyId: 1 },
      { id: 4, name: "Memorial Day", date: at("2026-05-25"), companyId: 1 },
      { id: 5, name: "Independence Day (observed)", date: at("2026-07-03"), companyId: 1 },
      { id: 6, name: "Christmas Day", date: at("2026-12-25"), companyId: 1 },
    ],
    adjustments: [
      // Carol's 2025 total is 25 − 15 = 10; she used 7, so 3 carried into 2026.
      adj(U.carol, 2025, -15, 0),
      adj(U.carol, 2026, 2, 3),
      // Everyone else employed through 2025 had at least 5 left, the company cap.
      ...[U.alice, U.bob, U.olivia, U.dave, U.erin, U.frank, U.henry, U.paula, U.nina].map((id) => adj(id, 2026, 0, 5)),
    ],
    schedules: [
      { monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 2, sunday: 2, company_id: 1, user_id: null },
      { monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 2, saturday: 2, sunday: 2, company_id: null, user_id: U.paula },
    ],
    supervisors: [],
  };
}

const DDL = `
create table "Companies" (id integer primary key, name varchar(255) not null, country varchar(255) not null, start_of_new_year integer not null,
  share_all_absences tinyint(1) not null default 0, is_team_view_hidden tinyint(1) not null default 0, ldap_auth_enabled tinyint(1) not null default 0,
  ldap_auth_config varchar(255), date_format varchar(255) not null default 'YYYY-MM-DD', company_wide_message text, mode integer not null default 1,
  timezone text default 'Europe/London', integration_api_enabled tinyint(1) not null default 0, integration_api_token uuid, carry_over integer not null default 0,
  createdAt datetime, updatedAt datetime);
create table "Departments" (id integer primary key, name varchar(255) not null, allowance integer not null default 20,
  include_public_holidays tinyint(1) not null default 1, is_accrued_allowance tinyint(1) not null default 0, createdAt datetime, updatedAt datetime,
  companyId integer references "Companies"(id), bossId integer);
create table "Users" (id integer primary key, email varchar(255) not null, password varchar(255) not null, name varchar(255) not null,
  lastname varchar(255) not null, activated tinyint(1) not null default 0, admin tinyint(1) not null default 0, auto_approve tinyint(1) not null default 0,
  start_date datetime not null, end_date datetime, createdAt datetime, updatedAt datetime, companyId integer references "Companies"(id),
  DepartmentId integer references "Departments"(id));
create table "LeaveTypes" (id integer primary key, name varchar(255) not null, color varchar(255) not null default '#ffffff',
  use_allowance tinyint(1) not null default 1, "limit" integer not null default 0, sort_order integer not null default 0,
  auto_approve tinyint(1) not null default 0, createdAt datetime, updatedAt datetime, companyId integer references "Companies"(id));
create table "Leaves" (id integer primary key, status integer not null, employee_comment varchar(255), approver_comment varchar(255),
  decided_at datetime, date_start datetime not null, day_part_start integer not null default 1, date_end datetime not null,
  day_part_end integer not null default 1, createdAt datetime, updatedAt datetime, userId integer references "Users"(id),
  approverId integer references "Users"(id), leaveTypeId integer references "LeaveTypes"(id));
create table "BankHolidays" (id integer primary key, name varchar(255) not null, date datetime not null, createdAt datetime, updatedAt datetime,
  companyId integer references "Companies"(id));
create table "user_allowance_adjustment" (id integer primary key, year integer not null, adjustment integer not null default 0,
  carried_over_allowance integer not null default 0, created_at datetime, user_id integer references "Users"(id), unique (user_id, year));
create table "schedule" (id integer primary key, monday integer not null default 1, tuesday integer not null default 1,
  wednesday integer not null default 1, thursday integer not null default 1, friday integer not null default 1,
  saturday integer not null default 2, sunday integer not null default 2, created_at datetime, updated_at datetime,
  company_id integer references "Companies"(id), user_id integer references "Users"(id));
create table "DepartmentSupervisor" (id integer primary key, created_at datetime, department_id integer not null, user_id integer not null);
`;

const TABLE_OF: Record<keyof FixtureData, string> = {
  companies: "Companies",
  departments: "Departments",
  users: "Users",
  leaveTypes: "LeaveTypes",
  leaves: "Leaves",
  bankHolidays: "BankHolidays",
  adjustments: "user_allowance_adjustment",
  schedules: "schedule",
  supervisors: "DepartmentSupervisor",
};

/**
 * Writes the fixture to `path` (which must not exist yet) and returns the data written.
 *
 * @param mutate Changes the default rows before they are written.
 */
export function buildTimeOffFixture(path: string, mutate?: (data: FixtureData) => void): FixtureData {
  const data = defaults();
  mutate?.(data);
  const db = new DatabaseSync(path);
  try {
    db.exec(DDL);
    for (const [key, table] of Object.entries(TABLE_OF) as [keyof FixtureData, string][]) {
      for (const row of data[key]) {
        const columns = Object.keys(row);
        const sql = `insert into "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) values (${columns.map(() => "?").join(", ")})`;
        db.prepare(sql).run(...(columns.map((c) => row[c]) as (string | number | null)[]));
      }
    }
  } finally {
    db.close();
  }
  return data;
}

/** A leave row in the fixture's shape, for `mutate`. */
export function fixtureLeave(
  data: FixtureData,
  row: { userId: number; leaveTypeId: number; start: string; end: string; status: number; dayPartStart?: number; dayPartEnd?: number },
): Record<string, unknown> {
  const id = Math.max(0, ...data.leaves.map((l) => Number(l.id))) + 1;
  const leave = {
    id,
    status: row.status,
    employee_comment: null,
    approver_comment: null,
    decided_at: row.status === 1 ? null : at(row.start, "08:00:00.000"),
    date_start: at(row.start),
    day_part_start: row.dayPartStart ?? 1,
    date_end: at(row.end),
    day_part_end: row.dayPartEnd ?? 1,
    createdAt: at(row.start, "07:00:00.000"),
    updatedAt: at(row.start, "07:00:00.000"),
    userId: row.userId,
    approverId: U.alice,
    leaveTypeId: row.leaveTypeId,
  };
  data.leaves.push(leave);
  return leave;
}
