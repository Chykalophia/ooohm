import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
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
  // Names are unique per company ignoring case, so "Sales" and "sales" can never both exist.
  (t) => [uniqueIndex("departments_company_lower_name_uq").on(t.companyId, sql`lower(${t.name})`)],
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
  (t) => [
    index("user_company_idx").on(t.companyId),
    index("user_manager_idx").on(t.managerId),
    // Better Auth looks emails up lowercased, so a mixed-case row could never sign in.
    check("user_email_lowercase", sql`${t.email} = lower(${t.email})`),
  ],
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
  (t) => [
    index("account_user_idx").on(t.userId),
    // One external identity (e.g. a Google account) maps to exactly one OOOhm user.
    uniqueIndex("account_provider_account_uq").on(t.providerId, t.accountId),
  ],
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
  (t) => [
    uniqueIndex("leave_types_company_code_uq").on(t.companyId, t.code),
    check("leave_types_default_allowance_nonneg", sql`${t.defaultAllowanceDays} >= 0`),
    check("leave_types_carryover_max_nonneg", sql`${t.carryoverMaxDays} >= 0`),
  ],
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
  (t) => [
    uniqueIndex("allowances_user_type_year_uq").on(t.userId, t.leaveTypeId, t.year),
    check("allowances_days_nonneg", sql`${t.days} >= 0`),
  ],
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
    // Approvals inbox: requests assigned to one approver, and every pending request
    // in a company for admins. Also backs the approver_id foreign key.
    index("leave_requests_approver_status_idx").on(t.approverId, t.status),
    index("leave_requests_company_status_idx").on(t.companyId, t.status),
    check("leave_requests_dates_ordered", sql`${t.endDate} >= ${t.startDate}`),
    check("leave_requests_days_positive", sql`${t.days} > 0`),
    // A half day consumes exactly 0.5; a full-day request consumes whole days.
    check(
      "leave_requests_days_match_portion",
      sql`(${t.dayPortion} = 'full' AND ${t.days} = trunc(${t.days})) OR (${t.dayPortion} <> 'full' AND ${t.days} = 0.5)`,
    ),
    // Half days (am/pm) only make sense on a single-day request.
    check("leave_requests_half_day_single", sql`${t.dayPortion} = 'full' OR ${t.startDate} = ${t.endDate}`),
    // At most MAX_REQUEST_SPAN_DAYS (366) calendar days, as submit enforces. Calendar
    // range queries rely on it to bound their index scan from below.
    check("leave_requests_span_max", sql`${t.endDate} - ${t.startDate} < 366`),
  ],
);

/**
 * What a leave request costs in each calendar year, fixed at submit time. A request
 * over New Year has one row per year; every other request has one row. Balances read
 * these rows, never recount days, so editing holidays later cannot change a past
 * balance. The rows for a request always add up to `leave_requests.days`.
 */
export const leaveRequestDays = pgTable(
  "leave_request_days",
  {
    requestId: uuid("request_id")
      .notNull()
      .references(() => leaveRequests.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    days: numeric("days", { precision: 5, scale: 1, mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.requestId, t.year] }),
    check("leave_request_days_days_positive", sql`${t.days} > 0`),
  ],
);

/* ------------------------------------------------------------------ */
/* Calendar feeds                                                     */
/* ------------------------------------------------------------------ */

/** Which calendar a feed serves: the owner's own leave, or the whole company's. */
export const calendarFeedKindEnum = pgEnum("calendar_feed_kind", ["personal", "team"]);

/**
 * Revocable ICS feed links. The token itself is never stored: only its SHA-256 (hex),
 * so a leaked database cannot be turned back into working links. A person has at most
 * one live (unrevoked) link per kind.
 */
export const calendarFeedTokens = pgTable(
  "calendar_feed_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: calendarFeedKindEnum("kind").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Last time a calendar app fetched the feed; updated at most hourly. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("calendar_feed_tokens_hash_uq").on(t.tokenHash),
    uniqueIndex("calendar_feed_tokens_live_uq").on(t.userId, t.kind).where(sql`${t.revokedAt} is null`),
    check("calendar_feed_tokens_hash_format", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
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
    /**
     * The person the change is about, when there is one: the requester of a leave
     * request, the owner of an allowance or calendar link, the person an admin edited.
     * Lets the audit viewer filter by person with one index.
     */
    subjectUserId: text("subject_user_id").references(() => user.id, { onDelete: "set null" }),
    before: jsonb("before"),
    after: jsonb("after"),
    // clock_timestamp(), not now(): rows written in one transaction keep their write order.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    index("audit_log_entity_idx").on(t.entityType, t.entityId),
    // The audit viewer pages newest first by (created_at, id) within a company, with at
    // most one of these filters narrowing the scan; each index serves one of them.
    index("audit_log_company_created_idx").on(t.companyId, t.createdAt, t.id),
    index("audit_log_company_action_idx").on(t.companyId, t.action, t.createdAt, t.id),
    index("audit_log_company_actor_idx").on(t.companyId, t.actorId, t.createdAt, t.id),
    index("audit_log_company_subject_idx").on(t.companyId, t.subjectUserId, t.createdAt, t.id),
  ],
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
    // clock_timestamp(), not now(): rows written in one transaction keep their write order.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [index("events_outbox_pending_idx").on(t.deliveredAt, t.createdAt)],
);
