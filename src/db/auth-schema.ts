import "server-only";
import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { DEFAULT_COLOR_MODE } from "@/shared/kernel/color-mode";
import { colorModeEnum, roleEnum, verification } from "./schema";

/**
 * Better Auth's tables as Better Auth reads them: the views `auth_user`, `auth_session`,
 * `auth_account` and `auth_passkey` (drizzle/0031_row_level_security.sql) over `user`,
 * `session`, `account` and `passkey`. Sign-in finds a person by email, a session by its
 * token, an account or a passkey before any company is known, which row-level security
 * would refuse on the tables themselves; the views are owned by the owner, so they read
 * through its policy. Only `src/lib/auth.ts` imports this
 * (tests/architecture/row-level-security.test.ts). The columns and their property names
 * are the tables' own (src/db/schema.ts), so Better Auth sees the same fields; `auth_user`
 * leaves out what sign-in never needs (deletion, scrub and level columns).
 *
 * Not in schema.ts, so drizzle-kit does not take the views for tables. `verification` has
 * no tenant, so Better Auth uses the table itself.
 */

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const authUser = pgTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  companyId: uuid("company_id"),
  departmentId: uuid("department_id"),
  managerId: text("manager_id"),
  role: roleEnum("role").notNull().default("employee"),
  canSelfApprove: boolean("can_self_approve").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  colorMode: colorModeEnum("theme").notNull().default(DEFAULT_COLOR_MODE),
  ...timestamps,
});

export const authSession = pgTable("auth_session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull(),
  ...timestamps,
});

export const authAccount = pgTable("auth_account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  ...timestamps,
});

export const authPasskey = pgTable("auth_passkey", {
  id: text("id").primaryKey(),
  name: text("name"),
  publicKey: text("public_key").notNull(),
  userId: text("user_id").notNull(),
  credentialID: text("credential_id").notNull(),
  counter: integer("counter").notNull(),
  deviceType: text("device_type").notNull(),
  backedUp: boolean("backed_up").notNull(),
  transports: text("transports"),
  createdAt: timestamp("created_at", { withTimezone: true }),
  aaguid: text("aaguid"),
});

/** The schema Better Auth's drizzle adapter is given: its model names, mapped to the views (and `verification`). */
export const authSchema = { user: authUser, session: authSession, account: authAccount, verification, passkey: authPasskey };
