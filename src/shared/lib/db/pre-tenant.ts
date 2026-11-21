import "server-only";
/**
 * The pre-tenant lookups (ADR-0004): the few reads that find a company before one is
 * known, through narrow SECURITY DEFINER functions (drizzle/0031 and 0032)
 * that read as the owner, past row-level security. Each is keyed by a secret (a key or
 * token hash, a signed link's person) or names only what its caller needs, and is called
 * only from here (tests/architecture/row-level-security.test.ts). Whatever the caller
 * does next runs for the company found, through `forTenant` (`@/shared/lib/tenant`).
 *
 * They run on any executor, bound to a company or not.
 */
import { type SQL, sql } from "drizzle-orm";
import { executeRows } from "@/db/rows";
import type { Executor } from "@/db/types";

/** A timestamp from a raw row: postgres.js hands back text (drizzle turns its parser off), PGlite a Date. */
function instant(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function instantOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : instant(value);
}

/** The live API key with this SHA-256 (REST API authentication). */
export async function findLiveApiKeyByHash(
  ex: Executor,
  keyHash: string,
): Promise<{ id: string; companyId: string; keyHash: string; scopes: string[]; lastUsedAt: Date | null } | undefined> {
  const [row] = await executeRows<{ id: string; company_id: string; key_hash: string; scopes: string[]; last_used_at: unknown }>(
    ex,
    sql`select id, company_id, key_hash, scopes, last_used_at from ooohm_api_key_for_hash(${keyHash})`,
  );
  return row && { id: row.id, companyId: row.company_id, keyHash: row.key_hash, scopes: row.scopes, lastUsedAt: instantOrNull(row.last_used_at) };
}

/** The live calendar feed with this token SHA-256, whose owner is active in its company, with what the feed shows. */
export async function findLiveFeedByHash(ex: Executor, tokenHash: string) {
  const [row] = await executeRows<{
    id: string;
    user_id: string;
    company_id: string;
    kind: "personal" | "team";
    last_used_at: unknown;
    company_name: string;
    timezone: string;
    owner_role: "employee" | "manager" | "admin";
    owner_manager_id: string | null;
    owner_department_id: string | null;
    colleague_visibility: string;
    department_scoping: boolean;
  }>(
    ex,
    sql`select id, user_id, company_id, kind, last_used_at, company_name, timezone, owner_role, owner_manager_id, owner_department_id,
          colleague_visibility, department_scoping
        from ooohm_calendar_feed_for_hash(${tokenHash})`,
  );
  return (
    row && {
      id: row.id,
      userId: row.user_id,
      companyId: row.company_id,
      kind: row.kind,
      lastUsedAt: instantOrNull(row.last_used_at),
      companyName: row.company_name,
      timezone: row.timezone,
      ownerRole: row.owner_role,
      ownerManagerId: row.owner_manager_id,
      ownerDepartmentId: row.owner_department_id,
      colleagueVisibility: row.colleague_visibility,
      departmentScoping: row.department_scoping,
    }
  );
}

/**
 * The person a signed approve link names, as an actor's fields, only while the link's
 * request (in their company) is assigned to them; a deleted person reads as missing.
 */
export async function findLinkPerson(
  ex: Executor,
  userId: string,
  requestId: string,
): Promise<{ id: string; companyId: string | null; role: "employee" | "manager" | "admin"; canSelfApprove: boolean; isActive: boolean } | undefined> {
  const [row] = await executeRows<{ id: string; company_id: string | null; role: "employee" | "manager" | "admin"; can_self_approve: boolean; is_active: boolean }>(
    ex,
    sql`select id, company_id, role, can_self_approve, is_active from ooohm_link_person(${userId}, ${requestId}::uuid)`,
  );
  return row && { id: row.id, companyId: row.company_id, role: row.role, canSelfApprove: row.can_self_approve, isActive: row.is_active };
}

/** The deployment company's (the oldest's) name, look and logo description, for pages shown before anyone is known. */
export async function findDeploymentBrand(ex: Executor) {
  const [row] = await executeRows<{
    name: string;
    theme: string;
    accent_color: string | null;
    corners: string;
    request_style: string;
    layout: string;
    logo_sha256: string | null;
    logo_type: string | null;
    logo_width: number | null;
    logo_height: number | null;
  }>(ex, sql`select name, theme, accent_color, corners, request_style, layout, logo_sha256, logo_type, logo_width, logo_height from ooohm_deployment_brand()`);
  return (
    row && {
      name: row.name,
      theme: row.theme,
      accentColor: row.accent_color,
      corners: row.corners,
      requestStyle: row.request_style,
      layout: row.layout,
      logoSha256: row.logo_sha256,
      logoType: row.logo_type,
      logoWidth: row.logo_width === null ? null : Number(row.logo_width),
      logoHeight: row.logo_height === null ? null : Number(row.logo_height),
    }
  );
}

/** A stored logo's bytes and type, by the SHA-256 that names it (public, like the favicon). */
export async function findLogoFile(ex: Executor, sha256: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
  const [row] = await executeRows<{ bytes: Uint8Array | null; content_type: string | null }>(ex, sql`select bytes, content_type from ooohm_logo_file(${sha256})`);
  if (!row?.bytes || !row.content_type) return undefined;
  const bytes = row.bytes;
  return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), contentType: row.content_type };
}

/** Every company, oldest first, with what a job that loops over them plans with. */
export async function listCompanies(ex: Executor): Promise<{ id: string; timezone: string; workingDays: number[]; allowancePolicy: string }[]> {
  const rows = await executeRows<{ id: string; timezone: string; working_days: number[]; allowance_policy: string }>(
    ex,
    sql`select id, timezone, working_days, allowance_policy from ooohm_companies()`,
  );
  return rows.map((r) => ({ id: r.id, timezone: r.timezone, workingDays: r.working_days.map(Number), allowancePolicy: r.allowance_policy }));
}

/** A queue's share per company: which companies hold its first items, and how many each. */
export interface CompanyShare {
  companyId: string;
  count: number;
}

/** The companies holding the oldest `limit` undispatched outbox events, oldest first, and how many each holds. */
export async function undispatchedEventCompanies(ex: Executor, limit: number): Promise<CompanyShare[]> {
  const rows = await executeRows<{ company_id: string; events: number }>(ex, sql`select company_id, events from ooohm_undispatched_event_companies(${limit}::integer)`);
  return rows.map((r) => ({ companyId: r.company_id, count: Number(r.events) }));
}

/** The companies holding the first `limit` webhook deliveries due at `now`, and how many each. */
export async function dueWebhookCompanies(ex: Executor, now: Date, limit: number): Promise<CompanyShare[]> {
  const rows = await executeRows<{ company_id: string; deliveries: number }>(
    ex,
    sql`select company_id, deliveries from ooohm_due_webhook_companies(${now.toISOString()}::timestamptz, ${limit}::integer)`,
  );
  return rows.map((r) => ({ companyId: r.company_id, count: Number(r.deliveries) }));
}

/** The companies holding the first `limit` adapter deliveries due at `now`, and how many each. */
export async function dueAdapterCompanies(ex: Executor, now: Date, limit: number): Promise<CompanyShare[]> {
  const rows = await executeRows<{ company_id: string; deliveries: number }>(
    ex,
    sql`select company_id, deliveries from ooohm_due_adapter_companies(${now.toISOString()}::timestamptz, ${limit}::integer)`,
  );
  return rows.map((r) => ({ companyId: r.company_id, count: Number(r.deliveries) }));
}

/** Full scrubs due at `now`, oldest first, after `cursor`: ids, companies and when each was due. */
export async function listDueScrubs(
  ex: Executor,
  now: Date,
  limit: number,
  cursor?: { at: Date; id: string },
): Promise<{ id: string; companyId: string | null; scrubScheduledAt: Date | null }[]> {
  const rows = await executeRows<{ id: string; company_id: string | null; scrub_scheduled_at: unknown }>(
    ex,
    sql`select id, company_id, scrub_scheduled_at from ooohm_due_scrubs(${now.toISOString()}::timestamptz, ${limit}::integer, ${cursor ? cursor.at.toISOString() : null}::timestamptz, ${cursor?.id ?? null}::text)`,
  );
  return rows.map((r) => ({ id: r.id, companyId: r.company_id, scrubScheduledAt: instantOrNull(r.scrub_scheduled_at) }));
}

/**
 * Of `emails` (already lowercased, as stored), those an account in any company uses: an
 * address belongs to one account, so an invite, a people import and a sync must see the
 * ones taken elsewhere. Only the addresses: nothing about whose they are.
 */
export async function emailsInUse(ex: Executor, emails: readonly string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const rows = await executeRows<{ email: string }>(
    ex,
    sql`select email from ooohm_emails_in_use(array[${sql.join(
      emails.map((e) => sql`${e}`),
      sql`, `,
    )}]::text[])`,
  );
  return new Set(rows.map((r) => r.email));
}

/** Sign-in: a person's company and whether they are active, by id or by email (lowercased, as stored). */
export async function findAuthPerson(ex: Executor, by: { userId: string } | { email: string }): Promise<{ companyId: string | null; isActive: boolean } | undefined> {
  const userId = "userId" in by ? by.userId : null;
  const email = "email" in by ? by.email : null;
  const [row] = await executeRows<{ company_id: string | null; is_active: boolean }>(
    ex,
    sql`select company_id, is_active from ooohm_auth_person(${userId}::text, ${email}::text)`,
  );
  return row && { companyId: row.company_id, isActive: row.is_active };
}

async function companyOrNull(ex: Executor, query: SQL): Promise<string | null> {
  const [row] = await executeRows<{ company_id: string | null }>(ex, query);
  return row?.company_id ?? null;
}

/** Sign-in: the company of the person a session token belongs to. */
export function findAuthSessionCompany(ex: Executor, token: string): Promise<string | null> {
  return companyOrNull(ex, sql`select ooohm_auth_session_company(${token}::text) as company_id`);
}

/** Sign-in: the company of an account's person, by the account's id or by its provider's account id. */
export function findAuthAccountCompany(ex: Executor, by: { id: string } | { providerId: string; accountId: string }): Promise<string | null> {
  const id = "id" in by ? by.id : null;
  const provider = "providerId" in by ? by : { providerId: null, accountId: null };
  return companyOrNull(ex, sql`select ooohm_auth_account_company(${id}::text, ${provider.providerId}::text, ${provider.accountId}::text) as company_id`);
}

/** Sign-in: the company of a passkey's person, by the passkey's id or its credential id. */
export function findAuthPasskeyCompany(ex: Executor, by: { id: string } | { credentialId: string }): Promise<string | null> {
  const id = "id" in by ? by.id : null;
  const credentialId = "credentialId" in by ? by.credentialId : null;
  return companyOrNull(ex, sql`select ooohm_auth_passkey_company(${id}::text, ${credentialId}::text) as company_id`);
}

/** Whether any company or person exists, whichever company: the web setup stays closed then. */
export async function isPopulated(ex: Executor): Promise<boolean> {
  const [row] = await executeRows<{ populated: boolean }>(ex, sql`select ooohm_is_populated() as populated`);
  return row?.populated === true;
}
