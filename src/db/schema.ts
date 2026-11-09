import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
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
import { DEFAULT_THEME } from "@/domain/appearance";
import { DEFAULT_LEAVE_TYPE_COLOR } from "@/domain/leave-type-settings";
import { COLOR_MODES, DEFAULT_COLOR_MODE } from "@/domain/color-mode";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

// Enums

export const roleEnum = pgEnum("role", ["employee", "manager", "admin"]);

/** A person's colour mode. Named `theme` in the database (it was, before company themes). */
export const colorModeEnum = pgEnum("theme", COLOR_MODES);

export const requestStatusEnum = pgEnum("leave_request_status", [
  "pending",
  "approved",
  "rejected",
  "cancelled",
]);

/** Which part of a day a request covers. Half days apply to single-day requests. */
export const dayPortionEnum = pgEnum("day_portion", ["full", "am", "pm"]);

// Tenancy

/**
 * One row once the first install has run, by the web setup (`/setup`) or `pnpm db:seed`.
 * From then on the web setup is closed for good, whatever `SETUP_TOKEN` says.
 */
export const installation = pgTable(
  "installation",
  {
    id: integer("id").primaryKey().default(1),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
    /** How it was done: `setup` (the web page) or `seed` (the CLI). */
    method: text("method").notNull(),
  },
  (t) => [check("installation_single_row", sql`${t.id} = 1`)],
);

export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** IANA time zone used for day boundaries, e.g. "America/Chicago". */
  timezone: text("timezone").notNull().default("America/Chicago"),
  /** ISO weekdays that are working days (1 = Monday ... 7 = Sunday). */
  workingDays: integer("working_days").array().notNull().default([1, 2, 3, 4, 5]),
  /** Allowance policy key. v1 ships "annual_calendar_year" only. */
  allowancePolicy: text("allowance_policy").notNull().default("annual_calendar_year"),
  /**
   * When on, a full-scrub delete waits `DELETION_GRACE_DAYS` (7) days, with undo, before
   * it runs; off by default. Deletes that keep records never wait.
   */
  deletionGrace: boolean("deletion_grace").notNull().default(false),
  /** Managers see their direct reports' balances and request notes on the team member page. */
  managersSeeDetails: boolean("managers_see_details").notNull().default(true),
  /**
   * `APPROVAL_MODES` in src/domain/approval-rule.ts: `required` (time off waits for an
   * approver) or `heads_up` (booked as it is sent; whoever would have approved it is told).
   */
  approvalMode: text("approval_mode").notNull().default("required"),
  /** `COLLEAGUE_VISIBILITY` in src/domain/calendar-visibility.ts: what employees see of colleagues' time off. */
  colleagueVisibility: text("colleague_visibility").notNull().default("everyone"),
  /** Theme key from `THEMES` in src/domain/appearance.ts, chosen by an admin for everyone. */
  theme: text("theme").notNull().default(DEFAULT_THEME),
  /** `#rrggbb` that replaces the theme's accent, or null for the theme's own. */
  accentColor: text("accent_color"),
  /** `theme`, `square`, `soft` or `round`: overrides the theme's corner radius. */
  corners: text("corners").notNull().default("theme"),
  /** `REQUEST_STYLES` in src/domain/appearance.ts: how Home asks for time off. */
  requestStyle: text("request_style").notNull().default("form"),
  /** `LAYOUTS` in src/domain/appearance.ts: the layout trial the whole company sees. */
  layout: text("layout").notNull().default("standard"),
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

/**
 * A company's own words for one email (Admin → Emails): its subject and message, with
 * `{{variable}}` placeholders. `type` is a notification type (`leave.requested`, `invite`).
 * A null field uses the email's default; a row with neither is deleted instead.
 */
export const emailTemplates = pgTable(
  "email_templates",
  {
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    subject: text("subject"),
    message: text("message"),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.type] }),
    check("email_templates_some_copy", sql`${t.subject} is not null or ${t.message} is not null`),
  ],
);

// Auth (Better Auth core tables + OOOhm user fields)

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
    /**
     * Set when an admin deleted the person. The row stays as a tombstone, so every
     * foreign key to it holds; its name and email are replaced (see `@/domain/person-deletion`).
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** How they were deleted: `scrubbed` (nothing about them kept) or `records_kept` (history kept under the tombstone). */
    deletionMode: text("deletion_mode"),
    /** A full scrub waiting out the company's grace period: when the daily job may run it. */
    scrubScheduledAt: timestamp("scrub_scheduled_at", { withTimezone: true }),
    /** The admin who asked for the scheduled scrub; the job's change is attributed to the system on their behalf. */
    scrubRequestedBy: text("scrub_requested_by").references((): AnyPgColumn => user.id, { onDelete: "set null" }),
    /** Their colour mode: light (the default), dark, or following their device (where the company theme has a dark version). */
    colorMode: colorModeEnum("theme").notNull().default(DEFAULT_COLOR_MODE),
    ...timestamps,
  },
  (t) => [
    // (company_id, id): company scoping everywhere, and keyset pages of the REST API's /users.
    index("user_company_id_idx").on(t.companyId, t.id),
    index("user_manager_idx").on(t.managerId),
    // The daily job's lookup of due scrubs. Partial: almost nobody is ever scheduled.
    index("user_scrub_scheduled_idx").on(t.scrubScheduledAt).where(sql`${t.scrubScheduledAt} is not null`),
    // Better Auth looks emails up lowercased, so a mixed-case row could never sign in.
    check("user_email_lowercase", sql`${t.email} = lower(${t.email})`),
    // A tombstone names its mode and can never be active; a live person has neither.
    check(
      "user_deletion_shape",
      sql`(${t.deletedAt} is null and ${t.deletionMode} is null)
        or (${t.deletedAt} is not null and ${t.deletionMode} in ('scrubbed', 'records_kept') and not ${t.isActive})`,
    ),
    // Only a deactivated, not yet deleted person can wait for a scrub. The requester may
    // be null while scheduled only if their own row was ever removed (the foreign key).
    check(
      "user_scrub_schedule_shape",
      sql`(${t.scrubScheduledAt} is null and ${t.scrubRequestedBy} is null)
        or (${t.scrubScheduledAt} is not null and ${t.deletedAt} is null and not ${t.isActive})`,
    ),
  ],
);

/**
 * Passkeys (WebAuthn credentials) people add on their account page, for Better Auth's
 * passkey plugin: one row per device or password manager. Signing in with one still
 * goes through the session hook that refuses deactivated people, and a delete removes
 * them with the rest of the person's sign-in data.
 */
export const passkey = pgTable(
  "passkey",
  {
    id: text("id").primaryKey(),
    /** What the person called it ("Work laptop"). */
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull(),
    /** The authenticator's signature counter, checked on every sign-in. */
    counter: integer("counter").notNull(),
    /** `singleDevice`, or `multiDevice` for a synced passkey. */
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    createdAt: timestamp("created_at", { withTimezone: true }),
    /** Identifies the authenticator's make (a password manager, a security key). */
    aaguid: text("aaguid"),
  },
  (t) => [index("passkey_user_idx").on(t.userId), uniqueIndex("passkey_credential_id_uq").on(t.credentialID)],
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

// Leave

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
    color: text("color").notNull().default(DEFAULT_LEAVE_TYPE_COLOR),
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
    /**
     * Working days this request consumes (weekends and holidays excluded): counted at
     * submit, and recounted when a holiday or the working days change in an open year.
     * Always more than 0 at submit; 0 only when a later calendar change (a holiday, or the working days) leaves it no working days.
     */
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
    // Keyset pages of the REST API's /leave-requests, ordered by (start_date, id).
    index("leave_requests_company_start_id_idx").on(t.companyId, t.startDate, t.id),
    index("leave_requests_status_idx").on(t.status),
    // Approvals inbox: requests assigned to one approver, and every pending request
    // in a company for admins. Also backs the approver_id foreign key.
    index("leave_requests_approver_status_idx").on(t.approverId, t.status),
    index("leave_requests_company_status_idx").on(t.companyId, t.status),
    check("leave_requests_dates_ordered", sql`${t.endDate} >= ${t.startDate}`),
    check("leave_requests_days_nonneg", sql`${t.days} >= 0`),
    // A half day consumes 0.5 (or 0, after a later calendar change); a full-day request consumes whole days.
    check(
      "leave_requests_days_match_portion",
      sql`(${t.dayPortion} = 'full' AND ${t.days} = trunc(${t.days})) OR (${t.dayPortion} <> 'full' AND ${t.days} IN (0, 0.5))`,
    ),
    // Half days (am/pm) only make sense on a single-day request.
    check("leave_requests_half_day_single", sql`${t.dayPortion} = 'full' OR ${t.startDate} = ${t.endDate}`),
    // At most MAX_REQUEST_SPAN_DAYS (366) calendar days, as submit enforces. Calendar
    // range queries rely on it to bound their index scan from below.
    check("leave_requests_span_max", sql`${t.endDate} - ${t.startDate} < 366`),
  ],
);

/**
 * What a leave request costs in each calendar year, stored at submit. A request over
 * New Year has one row per year; every other request has one row (none once a later
 * holiday covers all of it). Balances read these rows and never count days themselves.
 * A holiday or working-days change rewrites them for open years only, so a closed
 * year's balance never moves. The rows for a request always add up to
 * `leave_requests.days`.
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

// Calendar feeds

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

// Audit + integrations

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    /**
     * Who or what made the change (`ChangeSource`, `@/domain/change-source`): `user` (the
     * person in `actor_id`), `api_key` (the key's creator in `actor_id`, the key in
     * `api_key_id`) or `system` (the process in `actor_process`, nobody in `actor_id`).
     */
    actorKind: text("actor_kind").notNull(),
    /**
     * The person behind the change; `null` for `system`. Also `null` on a `user` or
     * `api_key` row whose person's account was deleted (OOOhm deactivates people and
     * never deletes them), which is why the shape check does not require it.
     */
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    /** `api_key` rows: the key used. `null` only if the key row was deleted. */
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    /** `user` and `api_key` rows: what the person acted through (`adapter_sync:<id>`), if anything. */
    actorVia: text("actor_via"),
    /** `system` rows: the process (`year_rollover`, `adapter_sync:<id>`; `unknown` for some rows written before attribution existed). */
    actorProcess: text("actor_process"),
    /**
     * `system` rows a person asked for ahead of time (a scheduled scrub): the person who
     * asked. Not the actor: the process made the change, on their behalf.
     */
    actorRequestedBy: text("actor_requested_by").references(() => user.id, { onDelete: "set null" }),
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
    // Keeps the foreign key's `set null` from scanning the log when a key row is deleted.
    index("audit_log_api_key_idx").on(t.apiKeyId).where(sql`${t.apiKeyId} is not null`),
    check("audit_log_actor_kind_known", sql`${t.actorKind} in ('user', 'api_key', 'system')`),
    check(
      "audit_log_actor_shape",
      sql`(${t.actorKind} = 'system' and ${t.actorProcess} is not null and ${t.actorId} is null and ${t.apiKeyId} is null and ${t.actorVia} is null)
        or (${t.actorKind} = 'user' and ${t.actorProcess} is null and ${t.apiKeyId} is null and ${t.actorRequestedBy} is null)
        or (${t.actorKind} = 'api_key' and ${t.actorProcess} is null and ${t.actorRequestedBy} is null)`,
    ),
  ],
);

/**
 * Transactional outbox for domain events (leave.requested, leave.approved, ...).
 * The outbox worker fans each row out to webhook endpoints and adapters, then sets
 * `delivered_at` (read it as "dispatched": the deliveries themselves are tracked in
 * `webhook_deliveries` and `adapter_deliveries`). The REST API's `/events` replays it.
 */
export const eventsOutbox = pgTable(
  "events_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    /** Unused: retries are counted per delivery. Kept, as columns are never dropped from a public table. */
    attempts: integer("attempts").notNull().default(0),
    /** When the worker dispatched the event (created its deliveries); `null` until then. */
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    // clock_timestamp(), not now(): rows written in one transaction keep their write order.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    /**
     * The id of the transaction that wrote the row. The events API pages in
     * `(tx_id, created_at, id)` order and only shows rows of transactions older than every
     * one still running, so a slow transaction can never commit a row behind a reader's
     * cursor. Rows that predate the column share the migration's id.
     */
    txId: bigint("tx_id", { mode: "number" }).notNull().default(sql`pg_current_xact_id()::text::bigint`),
  },
  (t) => [
    // The worker's claim: undispatched rows oldest first. Partial, so it stays small however long the history.
    index("events_outbox_undispatched_idx").on(t.createdAt, t.id).where(sql`${t.deliveredAt} is null`),
    // The events API: one company's events in commit-safe order, after a cursor.
    index("events_outbox_company_tx_idx").on(t.companyId, t.txId, t.createdAt, t.id),
  ],
);

/** Where a delivery stands. `pending` covers both "not tried yet" and "waiting to retry". */
export const deliveryStatusEnum = pgEnum("delivery_status", ["pending", "delivered", "failed", "cancelled"]);

/**
 * Outbound webhook endpoints, one company's each. Deleting is soft (`deleted_at`), so
 * deliveries and audit rows keep pointing at a real row.
 */
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    description: text("description").notNull().default(""),
    /** Subscribed event types, e.g. `{leave.approved,balance.adjusted}`. */
    eventTypes: text("event_types").array().notNull(),
    /**
     * The signing secret sealed with AES-256-GCM under `WEBHOOK_ENCRYPTION_KEY`, the
     * endpoint id as additional data (`v1.<iv>.<ciphertext>.<tag>`). The signer needs the
     * plaintext, so it is encrypted rather than hashed.
     */
    secretCiphertext: text("secret_ciphertext").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("webhook_endpoints_company_idx").on(t.companyId, t.createdAt).where(sql`${t.deletedAt} is null`),
    check("webhook_endpoints_event_types_nonempty", sql`cardinality(${t.eventTypes}) > 0`),
  ],
);

/**
 * One event to one webhook endpoint, with its retry state. The worker creates these
 * when it dispatches an outbox row (or an admin sends a `ping`), and delivers due ones.
 * `body` is the exact JSON sent, fixed at creation, so every retry carries the same
 * bytes; only the timestamp and signature headers change per attempt.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    /** The envelope id: the outbox id, or a generated one for a `ping`. Not a foreign key, since pings have no outbox row. */
    eventId: uuid("event_id").notNull(),
    eventType: text("event_type").notNull(),
    body: text("body").notNull(),
    status: deliveryStatusEnum("status").notNull().default("pending"),
    /** Attempts started, including one in flight. */
    attempts: integer("attempts").notNull().default(0),
    /** When the next attempt is due; while one is in flight, when its lease runs out. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastStatusCode: integer("last_status_code"),
    lastLatencyMs: integer("last_latency_ms"),
    /** A short code (`timeout`, `HTTP 500`, `blocked_address`); never a URL. */
    lastError: text("last_error"),
    /** The first 200 characters of the last response body, for debugging; never more. */
    lastResponseExcerpt: text("last_response_excerpt"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // At most one delivery of an event to an endpoint, so a re-dispatch cannot duplicate.
    uniqueIndex("webhook_deliveries_endpoint_event_uq").on(t.endpointId, t.eventId),
    // The worker's claim: due pending deliveries.
    index("webhook_deliveries_due_idx").on(t.nextAttemptAt, t.id).where(sql`${t.status} = 'pending'`),
    // An endpoint's recent deliveries, newest first, for the admin screen.
    index("webhook_deliveries_endpoint_created_idx").on(t.endpointId, t.createdAt, t.id),
  ],
);

/**
 * One outbox event to one registered adapter, with the same retry state as a webhook
 * delivery. Empty in v1, which ships no adapters.
 */
export const adapterDeliveries = pgTable(
  "adapter_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** The adapter's `id` in the registry. */
    adapterId: text("adapter_id").notNull(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => eventsOutbox.id, { onDelete: "cascade" }),
    status: deliveryStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("adapter_deliveries_adapter_event_uq").on(t.adapterId, t.eventId),
    index("adapter_deliveries_due_idx").on(t.nextAttemptAt, t.id).where(sql`${t.status} = 'pending'`),
    index("adapter_deliveries_event_idx").on(t.eventId),
  ],
);

/**
 * REST API keys. Only the SHA-256 of a key is stored (hex, `CHECK`ed), under a unique
 * index: a lookup is one probe. `prefix` (`ooohm_` and 8 characters) is what admins see.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    /** What the key may do. v1 grants `read` only; `write` is reserved. */
    scopes: text("scopes").array().notNull().default(sql`'{read}'::text[]`),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Last authenticated request; written at most once a minute. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("api_keys_hash_uq").on(t.keyHash),
    index("api_keys_company_created_idx").on(t.companyId, t.createdAt),
    check("api_keys_hash_format", sql`${t.keyHash} ~ '^[0-9a-f]{64}$'`),
    check("api_keys_scopes_known", sql`cardinality(${t.scopes}) > 0 and ${t.scopes} <@ array['read', 'write']::text[]`),
  ],
);

/**
 * One applied import from another leave tracker (v1: TimeOff.Management's SQLite file).
 * A dry run writes nothing, so every row here is an import that committed. The source
 * file's SHA-256 is unique: importing the same file twice is refused, since a second
 * run would duplicate every person's history.
 */
export const importRuns = pgTable(
  "import_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Which importer wrote it, e.g. `timeoff`. */
    source: text("source").notNull(),
    /** SHA-256 (hex) of the source file's bytes. */
    sourceSha256: text("source_sha256").notNull(),
    /** The file's base name, for people reading the run later; never a full path. */
    sourceFileName: text("source_file_name").notNull(),
    /** What was created, as the importer counted it. */
    counts: jsonb("counts").notNull(),
    /** The full report: warnings, conflicts and the balance reconciliation. */
    report: jsonb("report").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("import_runs_source_sha256_uq").on(t.sourceSha256),
    index("import_runs_company_idx").on(t.companyId, t.createdAt),
    check("import_runs_sha256_format", sql`${t.sourceSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * Periodic jobs the outbox worker runs (the year rollover, retention). A worker claims
 * a due job with a compare-and-set on `next_run_at`, so of several workers exactly one
 * runs it, and a restart does not run it again early.
 */
export const scheduledJobs = pgTable("scheduled_jobs", {
  name: text("name").primaryKey(),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
  lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
  lastFinishedAt: timestamp("last_finished_at", { withTimezone: true }),
  /** Why the last run failed (a short message), or `null` after a success. */
  lastError: text("last_error"),
});
