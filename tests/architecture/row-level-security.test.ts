import assert from "node:assert/strict";
import { test } from "node:test";
import { listFiles, read } from "./files";

/**
 * Row-level security stays complete (ADR-0004): every table in src/db/schema.ts is either a
 * tenant table, whose migrations enable and force row security with a policy for each
 * operation, or listed here as having no tenant, with the reason. The SECURITY DEFINER
 * functions (which read past the policies, as the owner) are exactly the ones listed, each
 * with its search_path pinned, and only the files listed call them. The SQL suite that
 * proves the policies hold is tests/integration/rls.test.ts.
 */

/** Tables scoped through a parent instead of a company_id of their own. */
const SCOPED_THROUGH_PARENT: Record<string, string> = {
  allowances: "a person's (user_id), of the tenant's leave type",
  leave_request_days: "a leave request's (request_id)",
  session: "a person's (user_id); Better Auth reaches it in the person's company (src/lib/auth-adapter.ts)",
  account: "a person's (user_id); Better Auth reaches it in the person's company (src/lib/auth-adapter.ts)",
  passkey: "a person's (user_id); Better Auth reaches it in the person's company (src/lib/auth-adapter.ts)",
};

/** Tables that belong to no company, so row security does not apply. */
const NO_TENANT: Record<string, string> = {
  installation: "one row for the whole deployment: whether the first install ran",
  scheduled_jobs: "the worker's job leases, one row per job for the whole deployment",
  verification: "Better Auth's live sign-in tokens, keyed by email before anyone is known; no person or company link (ADR-0004 says what that leaves open)",
};

/**
 * Every SECURITY DEFINER function, and the one file that calls it. Pre-tenant ones find a
 * company before one is known (each keyed by a secret, or naming only what its caller
 * needs); tenant ones act inside the caller's tenant on rows the app role cannot change.
 */
const DEFINER_FUNCTIONS: Record<string, { calledFrom: string; why: string }> = {
  ooohm_api_key_for_hash: { calledFrom: "src/shared/lib/db/pre-tenant.ts", why: "REST API authentication by the key's SHA-256" },
  ooohm_calendar_feed_for_hash: { calledFrom: "src/shared/lib/db/pre-tenant.ts", why: "calendar feeds by the token's SHA-256" },
  ooohm_link_person: { calledFrom: "src/shared/lib/db/pre-tenant.ts", why: "the person a signed approve link names, only for a request assigned to them" },
  ooohm_deployment_brand: { calledFrom: "src/shared/lib/db/pre-tenant.ts", why: "the sign-in page's and the favicon's look" },
  ooohm_logo_file: { calledFrom: "src/shared/lib/db/pre-tenant.ts", why: "public logo files by their SHA-256" },
  ooohm_companies: { calledFrom: "src/shared/lib/db/pre-tenant.ts", why: "jobs that loop over companies" },
  ooohm_undispatched_event_companies: { calledFrom: "src/shared/lib/db/pre-tenant.ts", why: "which companies the outbox worker dispatches for" },
  ooohm_due_webhook_companies: { calledFrom: "src/shared/lib/db/pre-tenant.ts", why: "which companies have webhook deliveries due" },
  ooohm_due_adapter_companies: { calledFrom: "src/shared/lib/db/pre-tenant.ts", why: "which companies have adapter deliveries due" },
  ooohm_due_scrubs: { calledFrom: "src/shared/lib/db/pre-tenant.ts", why: "the scheduled-scrub job's due people (ids only)" },
  ooohm_emails_in_use: { calledFrom: "src/shared/lib/db/pre-tenant.ts", why: "an address is one account's: invites, imports and syncs see those taken elsewhere (the addresses only)" },
  ooohm_auth_person: { calledFrom: "src/shared/lib/db/pre-tenant.ts", why: "sign-in: a person's company and whether they are active, by id or email" },
  ooohm_auth_session_company: { calledFrom: "src/shared/lib/db/pre-tenant.ts", why: "sign-in: a session's company, by its secret token" },
  ooohm_auth_account_company: { calledFrom: "src/shared/lib/db/pre-tenant.ts", why: "sign-in: an account's company, by id or provider account" },
  ooohm_auth_passkey_company: { calledFrom: "src/shared/lib/db/pre-tenant.ts", why: "sign-in: a passkey's company, by id or credential" },
  ooohm_is_populated: { calledFrom: "src/shared/lib/db/pre-tenant.ts", why: "the web setup stays closed on a database that holds any company or person" },
  ooohm_erase_audit_about: { calledFrom: "src/modules/people/infrastructure/drizzle-person-deletion.repository.ts", why: "a deletion erases audit rows (tenant only)" },
  ooohm_redact_audit_snapshots: { calledFrom: "src/modules/people/infrastructure/drizzle-person-deletion.repository.ts", why: "a deletion redacts audit rows (tenant only)" },
};

/**
 * The SECURITY DEFINER trigger functions (drizzle/0032): each checks that a row's references
 * name rows of its own company, as the owner so that another company's id and a missing one
 * get the same refusal. A trigger function cannot be called, only fired.
 */
const DEFINER_TRIGGERS: Record<string, string> = {
  ooohm_user_references: '"user": manager_id, department_id, level_id, scrub_requested_by',
  ooohm_departments_references: "departments: manager_id",
  ooohm_allowance_rules_references: "allowance_rules: leave_type_id, department_id, level_id",
  ooohm_leave_requests_references: "leave_requests: user_id, leave_type_id, approver_id",
  ooohm_calendar_feed_tokens_references: "calendar_feed_tokens: user_id",
  ooohm_audit_log_references: "audit_log: actor_id, actor_requested_by, subject_user_id, api_key_id",
  ooohm_webhook_endpoints_references: "webhook_endpoints: created_by",
  ooohm_webhook_deliveries_references: "webhook_deliveries: endpoint_id",
  ooohm_adapter_deliveries_references: "adapter_deliveries: event_id",
  ooohm_api_keys_references: "api_keys: created_by",
};

/** Views the app role may use although they read as their owner (none: Better Auth's were dropped in drizzle/0032). */
const VIEWS_READ_AS_OWNER: string[] = [];

const schema = read("src/db/schema.ts");
const migrations = listFiles("drizzle", /\.sql$/).map((path) => ({ path, sql: read(path) }));
const allSql = migrations.map((m) => m.sql).join("\n");

/** Each `pgTable("name", ...)` in the schema, with whether its columns include `company_id`. */
function schemaTables(): { name: string; hasCompanyId: boolean }[] {
  const starts = [...schema.matchAll(/pgTable\(\s*"([a-z_]+)"/g)];
  return starts.map((m, i) => {
    const body = schema.slice(m.index, starts[i + 1]?.index ?? schema.length);
    return { name: m[1]!, hasCompanyId: /uuid\("company_id"\)/.test(body) };
  });
}

const tables = schemaTables();
const tenantTables = tables.filter((t) => t.hasCompanyId || t.name === "companies" || t.name in SCOPED_THROUGH_PARENT).map((t) => t.name);

test("the schema scan finds the tables", () => {
  assert.ok(tables.length >= 20, "pgTable declarations not found: the scan is broken");
  assert.ok(tenantTables.includes("leave_requests") && tenantTables.includes("user"));
});

test("every table is a tenant table or is listed as having no tenant", () => {
  const unclassified = tables.filter((t) => !tenantTables.includes(t.name) && !(t.name in NO_TENANT)).map((t) => t.name);
  assert.deepEqual(unclassified, [], "give the table a company_id and policies, scope it through a parent (SCOPED_THROUGH_PARENT), or say why it has no tenant (NO_TENANT)");
  for (const name of [...Object.keys(SCOPED_THROUGH_PARENT), ...Object.keys(NO_TENANT)]) {
    assert.ok(tables.some((t) => t.name === name), `${name} is listed here but is not in src/db/schema.ts`);
  }
});

test("every tenant table has row security enabled and forced, with a policy per operation, in the migrations", () => {
  const missing: string[] = [];
  for (const table of tenantTables) {
    const on = `"public"."${table}"`;
    if (!allSql.includes(`ALTER TABLE ${on} ENABLE ROW LEVEL SECURITY`)) missing.push(`${table}: ENABLE ROW LEVEL SECURITY`);
    if (!allSql.includes(`ALTER TABLE ${on} FORCE ROW LEVEL SECURITY`)) missing.push(`${table}: FORCE ROW LEVEL SECURITY`);
    for (const op of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      const policy = new RegExp(`CREATE POLICY "[a-z_]+" ON ${on.replaceAll(".", "\\.")} AS PERMISSIVE FOR ${op} TO PUBLIC (USING|WITH CHECK) \\([^;]*ooohm_tenant\\(\\)`);
      if (!policy.test(allSql)) missing.push(`${table}: a ${op} policy on ooohm_tenant()`);
    }
    if (!/ FOR UPDATE TO PUBLIC USING \(.*\) WITH CHECK \(/.test(allSql.split("\n").find((l) => l.includes(`ON ${on} AS PERMISSIVE FOR UPDATE`)) ?? "")) {
      missing.push(`${table}: the UPDATE policy checks the new row too (WITH CHECK)`);
    }
  }
  assert.deepEqual(missing, [], "add them in a migration (copy a block from drizzle/0031_row_level_security.sql)");
});

test("no migration turns row security off or drops a tenant policy", () => {
  const weakening = migrations.filter((m) => /DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY|DROP POLICY|BYPASSRLS/i.test(m.sql)).map((m) => m.path);
  assert.deepEqual(weakening, []);
});

test("the SECURITY DEFINER functions are exactly the listed ones, each with its search_path pinned", () => {
  const found = new Map<string, string>();
  for (const m of migrations) {
    for (const match of m.sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION "public"\."([a-z_]+)"\(([\s\S]*?)\$\$/g)) {
      const header = match[2]!;
      if (/SECURITY DEFINER/.test(header)) found.set(match[1]!, header);
    }
  }
  assert.deepEqual(
    [...found.keys()].sort(),
    [...Object.keys(DEFINER_FUNCTIONS), ...Object.keys(DEFINER_TRIGGERS)].sort(),
    "a new SECURITY DEFINER function reads past row security: list it in DEFINER_FUNCTIONS (or DEFINER_TRIGGERS) with why",
  );
  for (const [name, header] of found) assert.match(header, /SET search_path = pg_catalog, public/, `${name} pins its search_path`);
  for (const name of Object.keys(DEFINER_TRIGGERS)) {
    assert.match(found.get(name) ?? "", /RETURNS trigger/, `${name} is a trigger function, which cannot be called`);
    assert.ok(new RegExp(`EXECUTE FUNCTION "public"\\."${name}"\\(\\)`).test(allSql), `${name} is fired by a trigger`);
  }
});

test("each SECURITY DEFINER function is called only from its listed file", () => {
  const sources = listFiles("src", /\.(ts|tsx)$/);
  for (const [name, { calledFrom }] of Object.entries(DEFINER_FUNCTIONS)) {
    const callers = sources.filter((path) => new RegExp(`\\b${name}\\(`).test(read(path)));
    assert.deepEqual(callers, [calledFrom], `${name} is called from ${calledFrom} only`);
  }
});

test("Better Auth reaches its tables under row security, through no view", () => {
  const sources = listFiles("src", /\.(ts|tsx)$/);
  const naming = sources.filter((path) => /\bauth_(user|session|account|passkey)\b/.test(read(path)));
  assert.deepEqual(naming, [], "the owner's auth views are gone (drizzle/0032): Better Auth uses the tables, in the person's company");
  const adapters = sources.filter((path) => /\bdrizzleAdapter\(/.test(read(path)));
  assert.deepEqual(adapters, ["src/lib/auth-adapter.ts"], "Better Auth's drizzle adapter is made only by the tenant-routing adapter");
  assert.match(read("src/lib/auth.ts"), /tenantRoutedAdapter\(/, "src/lib/auth.ts gives Better Auth the tenant-routing adapter");
});

test("every view a migration leaves in place reads as its caller, or is listed", () => {
  const created = migrations.flatMap((m, i) =>
    [...m.sql.matchAll(/CREATE (?:OR REPLACE )?(?:MATERIALIZED )?VIEW "public"\."([a-z_]+)"([^;]*?) AS/g)].map((v) => ({ name: v[1]!, options: v[2]!, at: i })),
  );
  const left = created.filter((v) => !migrations.slice(v.at + 1).some((m) => new RegExp(`DROP VIEW (IF EXISTS )?"public"\\."${v.name}"`).test(m.sql)));
  const asOwner = left.filter((v) => !/security_invoker/.test(v.options) && !VIEWS_READ_AS_OWNER.includes(v.name)).map((v) => v.name);
  assert.deepEqual(asOwner, [], "a view reads as its owner, past row security: create it WITH (security_invoker), or list it with why");
  assert.match(read("deploy/db-roles.sql"), /relkind IN \('v', 'm'\)/, "deploy/db-roles.sql takes the app role's rights on views back");
});

test("the demo and docs scripts write demo data as the owner, since row security hides every row from a session without a company", () => {
  for (const path of ["site/demo/demo-data.mts", "site/demo/docs-screens.mjs", "site/demo/record.mjs", "tests/e2e/demo-setup.mts"]) {
    assert.match(read(path), /DATABASE_ADMIN_URL/, path);
  }
});

test("the tenant setting and the embedded role switch are set in src/db/tenant.ts only", () => {
  const setters = listFiles("src", /\.(ts|tsx)$/).filter((path) => /set_config\(/.test(read(path)));
  assert.deepEqual(setters.filter((path) => path !== "src/db/tenant.ts" && path !== "src/db/connect.ts" && path !== "src/server/admin/db.ts"), []);
  // connect.ts and admin/db.ts set only the role setup's ooohm.* settings.
  for (const path of ["src/db/connect.ts", "src/server/admin/db.ts"]) {
    assert.doesNotMatch(read(path), /app\.company_id|set_config\('role'/, `${path} does not set the tenant or the role`);
  }
});

test("a transaction switches company only to record a person's own calendar link revoke in that link's company", () => {
  const sources = listFiles("src", /\.(ts|tsx)$/);
  const users = (name: string) => sources.filter((path) => new RegExp(`\\b${name}\\b`).test(read(path)));
  assert.deepEqual(users("switchTenantWithin"), ["src/db/tenant.ts", "src/shared/lib/tenant.ts"]);
  assert.deepEqual(users("recordInCompanyWithin"), ["src/modules/calendar/application/feed-changes.ts", "src/shared/lib/tenant.ts"]);
});

test("no database role is given BYPASSRLS", () => {
  for (const path of [...listFiles("deploy", /\.(sql|ya?ml|sh)$/), "docker-compose.yml"]) {
    assert.doesNotMatch(read(path).replaceAll("NOBYPASSRLS", "").replaceAll("rolbypassrls", ""), /BYPASSRLS/i, path);
  }
});
