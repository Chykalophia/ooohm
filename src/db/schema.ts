import {
  type AnyPgColumn,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/* ------------------------------------------------------------------ */
/* Enums                                                              */
/* ------------------------------------------------------------------ */

export const roleEnum = pgEnum("role", ["employee", "manager", "admin"]);

export const requestStatusEnum = pgEnum("leave_request_status", [
  "pending",
  "approved",
  "rejected",
  "cancelled",
]);

/** Which part of a day a request covers. Half days apply to single-day requests. */
export const dayPortionEnum = pgEnum("day_portion", ["full", "am", "pm"]);

/* ------------------------------------------------------------------ */
/* Tenancy                                                            */
/* ------------------------------------------------------------------ */

export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** IANA time zone used for day boundaries, e.g. "America/Chicago". */
  timezone: text("timezone").notNull().default("America/Chicago"),
  /** ISO weekdays that are working days (1 = Monday ... 7 = Sunday). */
  workingDays: integer("working_days").array().notNull().default([1, 2, 3, 4, 5]),
  /** Allowance policy key. v1 ships "annual_calendar_year" only. */
  allowancePolicy: text("allowance_policy").notNull().default("annual_calendar_year"),
  ...timestamps,
});

export const departments = pgTable(
  "departments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("departments_company_name_uq").on(t.companyId, t.name)],
);

/* ------------------------------------------------------------------ */
/* Auth (Better Auth core tables + OOOhm user fields)                 */
/* ------------------------------------------------------------------ */

export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    // OOOhm fields
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    departmentId: uuid("department_id").references(() => departments.id, {
      onDelete: "set null",
    }),
    managerId: text("manager_id").references((): AnyPgColumn => user.id, { onDelete: "set null" }),
    role: roleEnum("role").notNull().default("employee"),
    /** When true, this user's own requests are approved automatically. */
    canSelfApprove: boolean("can_self_approve").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("user_company_idx").on(t.companyId), index("user_manager_idx").on(t.managerId)],
);

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

/* ------------------------------------------------------------------ */
/* Leave                                                              */
/* ------------------------------------------------------------------ */

export const leaveTypes = pgTable(
  "leave_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Short label for calendars, e.g. "PTO". */
    code: text("code").notNull(),
    color: text("color").notNull().default("#6b7280"),
    isPaid: boolean("is_paid").notNull().default(true),
    /** When false, taking this leave never reduces a balance. */
    countsAgainstAllowance: boolean("counts_against_allowance").notNull().default(true),
    /** Default yearly allowance in days for new users. Null = unlimited / not tracked. */
    defaultAllowanceDays: numeric("default_allowance_days", {
      precision: 5,
      scale: 1,
      mode: "number",
    }),
    /** Carryover is off by default. When on, up to `carryoverMaxDays` roll into the next year. */
    carryoverEnabled: boolean("carryover_enabled").notNull().default(false),
    carryoverMaxDays: numeric("carryover_max_days", { precision: 5, scale: 1, mode: "number" }),
    sortOrder: integer("sort_order").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("leave_types_company_code_uq").on(t.companyId, t.code)],
);

/** Per-user allowance for one leave type in one calendar year. */
export const allowances = pgTable(
  "allowances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    leaveTypeId: uuid("leave_type_id")
      .notNull()
      .references(() => leaveTypes.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    days: numeric("days", { precision: 5, scale: 1, mode: "number" }).notNull(),
    carriedOverDays: numeric("carried_over_days", { precision: 5, scale: 1, mode: "number" })
      .notNull()
      .default(0),
    /** Manual +/- correction by an admin; every change is written to the audit log. */
    adjustmentDays: numeric("adjustment_days", { precision: 5, scale: 1, mode: "number" })
      .notNull()
      .default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex("allowances_user_type_year_uq").on(t.userId, t.leaveTypeId, t.year)],
);

export const holidays = pgTable(
  "holidays",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    date: date("date", { mode: "string" }).notNull(),
    name: text("name").notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("holidays_company_date_uq").on(t.companyId, t.date)],
);

export const leaveRequests = pgTable(
  "leave_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    leaveTypeId: uuid("leave_type_id")
      .notNull()
      .references(() => leaveTypes.id),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    dayPortion: dayPortionEnum("day_portion").notNull().default("full"),
    /** Working days this request consumes, computed at submit time (weekends/holidays excluded). */
    days: numeric("days", { precision: 5, scale: 1, mode: "number" }).notNull(),
    note: text("note"),
    status: requestStatusEnum("status").notNull().default("pending"),
    approverId: text("approver_id").references(() => user.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    ...timestamps,
  },
  (t) => [
    index("leave_requests_user_idx").on(t.userId),
    index("leave_requests_company_dates_idx").on(t.companyId, t.startDate, t.endDate),
    index("leave_requests_status_idx").on(t.status),
  ],
);

/* ------------------------------------------------------------------ */
/* Audit + integrations                                               */
/* ------------------------------------------------------------------ */

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    /** e.g. "leave_request.approved", "allowance.adjusted". */
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_entity_idx").on(t.entityType, t.entityId)],
);

/**
 * Transactional outbox for domain events (leave.requested, leave.approved, ...).
 * Webhooks and future adapters read from here; no adapters ship in v1.
 */
export const eventsOutbox = pgTable(
  "events_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    attempts: integer("attempts").notNull().default(0),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("events_outbox_pending_idx").on(t.deliveredAt, t.createdAt)],
);
