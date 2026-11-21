import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { createTestDatabase, type RawQuery, skip, type TestDatabase } from "./harness";

/**
 * Row-level security (ADR-0004, drizzle/0031_row_level_security.sql), table by table, in
 * SQL as the app role: what pgTAP would check, from node:test, on Postgres and on embedded
 * PGlite (whose app handle acts as a non-superuser role).
 *
 * For every tenant table: with company A's tenant set, B's rows cannot be read, changed or
 * deleted, and no row can be written for B; with no tenant, nothing is visible and nothing
 * can be written; the owner sees both companies.
 */

const REFUSED = { code: "42501" }; // insufficient_privilege: a policy's WITH CHECK, or a missing grant

interface Seeded {
  companyId: string;
  userId: string;
  leaveTypeId: string;
  departmentId: string;
  levelId: string;
  requestId: string;
  endpointId: string;
  eventId: string;
  apiKeyId: string;
}

/** How one tenant table is exercised: its rows of a company, a fresh row for it, and the column that names its tenant. */
interface TableCase {
  table: string;
  /** The predicate selecting `co`'s seeded rows, with `$1`. */
  rowsOf: (co: Seeded) => [where: string, param: string];
  /** An INSERT of a new row belonging to `co`. */
  insert: (co: Seeded) => [sql: string, params: unknown[]];
  /** An assignment that moves a row to `co` (`company_id = $2`, or a parent column). */
  moveTo: (co: Seeded) => [set: string, param: string];
  /** A no-op assignment, to try UPDATE. */
  touch: string;
  /** The app role may only read and add rows (audit_log): UPDATE and DELETE fail on the grant, before any policy. */
  appendOnly?: boolean;
}

const byCompany = (table: string, touch: string, insert: TableCase["insert"], extra: Partial<TableCase> = {}): TableCase => ({
  table,
  rowsOf: (co) => ["company_id = $1", co.companyId],
  insert,
  moveTo: (co) => ["company_id = $2", co.companyId],
  touch,
  ...extra,
});

const hex64 = () => randomUUID().replaceAll("-", "").padEnd(64, "0");

const CASES: TableCase[] = [
  {
    table: "companies",
    rowsOf: (co) => ["id = $1", co.companyId],
    insert: (co) => ["insert into companies (id, name) values ($1, 'X')", [co.companyId]],
    moveTo: (co) => ["id = $2", co.companyId],
    touch: "name = name",
  },
  byCompany("departments", "name = name", (co) => ["insert into departments (company_id, name) values ($1, $2)", [co.companyId, `D ${randomUUID()}`]]),
  byCompany("levels", "name = name", (co) => ["insert into levels (company_id, name) values ($1, $2)", [co.companyId, `L ${randomUUID()}`]]),
  byCompany("email_templates", "type = type", (co) => ["insert into email_templates (company_id, type, subject) values ($1, $2, 's')", [co.companyId, `t-${randomUUID()}`]]),
  byCompany("user", "name = name", (co) => ['insert into "user" (id, name, email, company_id) values ($2, \'U\', $3, $1)', [co.companyId, randomUUID(), `${randomUUID()}@example.com`]]),
  byCompany("leave_types", "name = name", (co) => ["insert into leave_types (company_id, name, code) values ($1, 'T', $2)", [co.companyId, `C${randomUUID().slice(0, 6)}`]]),
  byCompany("allowance_rules", "days = days", (co) => ["insert into allowance_rules (company_id, leave_type_id, level_id, days) values ($1, $2, $3, 3)", [co.companyId, co.leaveTypeId, co.levelId]]),
  byCompany("holidays", "name = name", (co) => ["insert into holidays (company_id, date, name) values ($1, '2031-01-02', 'H')", [co.companyId]]),
  byCompany("leave_requests", "note = note", (co) => [
    "insert into leave_requests (company_id, user_id, leave_type_id, start_date, end_date, days) values ($1, $2, $3, '2031-03-03', '2031-03-03', 1)",
    [co.companyId, co.userId, co.leaveTypeId],
  ]),
  byCompany("calendar_feed_tokens", "kind = kind", (co) => [
    "insert into calendar_feed_tokens (company_id, user_id, kind, token_hash) values ($1, $2, 'team', $3)",
    [co.companyId, co.userId, hex64()],
  ]),
  byCompany(
    "audit_log",
    "action = action",
    (co) => ["insert into audit_log (company_id, action, entity_type, entity_id, actor_kind, actor_process) values ($1, 'x', 'x', 'x', 'system', 'test')", [co.companyId]],
    { appendOnly: true },
  ),
  byCompany("events_outbox", "type = type", (co) => ["insert into events_outbox (company_id, type, payload) values ($1, 'x', '{}')", [co.companyId]]),
  byCompany("webhook_endpoints", "url = url", (co) => [
    "insert into webhook_endpoints (id, company_id, url, event_types, secret_ciphertext) values ($2, $1, 'https://example.com', '{x}', 'v1')",
    [co.companyId, randomUUID()],
  ]),
  byCompany("webhook_deliveries", "body = body", (co) => [
    "insert into webhook_deliveries (company_id, endpoint_id, event_id, event_type, body, next_attempt_at) values ($1, $2, $3, 'x', '{}', now())",
    [co.companyId, co.endpointId, randomUUID()],
  ]),
  byCompany("adapter_deliveries", "adapter_id = adapter_id", (co) => [
    "insert into adapter_deliveries (company_id, adapter_id, event_id, next_attempt_at) values ($1, $2, $3, now())",
    [co.companyId, `a-${randomUUID()}`, co.eventId],
  ]),
  byCompany("api_keys", "name = name", (co) => ["insert into api_keys (company_id, name, prefix, key_hash) values ($1, 'k', 'ooohm_x', $2)", [co.companyId, hex64()]]),
  byCompany("import_runs", "source = source", (co) => [
    "insert into import_runs (company_id, source, source_sha256, source_file_name, counts, report) values ($1, 'timeoff', $2, 'f.sqlite', '{}', '{}')",
    [co.companyId, hex64()],
  ]),
  // Scoped through their parent.
  {
    table: "allowances",
    rowsOf: (co) => ["user_id = $1", co.userId],
    insert: (co) => ["insert into allowances (user_id, leave_type_id, year, days) values ($1, $2, 2040, 1)", [co.userId, co.leaveTypeId]],
    moveTo: (co) => ["user_id = $2", co.userId],
    touch: "days = days",
  },
  {
    table: "leave_request_days",
    rowsOf: (co) => ["request_id = $1", co.requestId],
    insert: (co) => ["insert into leave_request_days (request_id, year, days) values ($1, 2041, 1)", [co.requestId]],
    moveTo: (co) => ["request_id = $2", co.requestId],
    touch: "days = days",
  },
  {
    table: "session",
    rowsOf: (co) => ["user_id = $1", co.userId],
    insert: (co) => ["insert into session (id, expires_at, token, user_id) values ($2, now(), $3, $1)", [co.userId, randomUUID(), randomUUID()]],
    moveTo: (co) => ["user_id = $2", co.userId],
    touch: "token = token",
  },
  {
    table: "account",
    rowsOf: (co) => ["user_id = $1", co.userId],
    insert: (co) => ["insert into account (id, account_id, provider_id, user_id) values ($2, $3, 'google', $1)", [co.userId, randomUUID(), randomUUID()]],
    moveTo: (co) => ["user_id = $2", co.userId],
    touch: "scope = scope",
  },
  {
    table: "passkey",
    rowsOf: (co) => ["user_id = $1", co.userId],
    insert: (co) => [
      "insert into passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up) values ($2, 'k', $1, $3, 0, 'singleDevice', false)",
      [co.userId, randomUUID(), randomUUID()],
    ],
    moveTo: (co) => ["user_id = $2", co.userId],
    touch: "counter = counter",
  },
];

/** Views the app role may use although they read as their owner: none. */
const VIEWS_READ_AS_OWNER: string[] = [];

/** One column that names another row: a write of `co`'s that points it at `target`. */
interface ReferenceCase {
  name: string;
  write: (co: Seeded, target: string) => [sql: string, params: unknown[]];
  target: (other: Seeded) => string;
  missing: () => string;
}

const person = (other: Seeded) => other.userId;
const newPerson = () => `missing-${randomUUID()}`;
const newId = () => randomUUID();
const leaveRequest = (day: string) =>
  `insert into leave_requests (company_id, user_id, leave_type_id, start_date, end_date, days) values ($1, $2, $3, '${day}', '${day}', 1)`;
const delivery = "insert into webhook_deliveries (company_id, endpoint_id, event_id, event_type, body, next_attempt_at) values ($1, $2, $3, 'x', '{}', now())";
const audit = (columns: string, values: string) => `insert into audit_log (company_id, action, entity_type, entity_id, ${columns}) values ($1, 'x', 'x', 'x', ${values})`;

/**
 * Every reference from one tenant row to another (ADR-0004 lists them). Not webhook_deliveries.event_id:
 * a ping's event is in no outbox, only in the delivery's own body, so it names no row.
 */
const REFERENCES: ReferenceCase[] = [
  { name: "leave_requests.user_id", target: person, missing: newPerson, write: (co, x) => [leaveRequest("2032-01-05"), [co.companyId, x, co.leaveTypeId]] },
  { name: "leave_requests.leave_type_id", target: (o) => o.leaveTypeId, missing: newId, write: (co, x) => [leaveRequest("2032-01-06"), [co.companyId, co.userId, x]] },
  { name: "leave_requests.approver_id", target: person, missing: newPerson, write: (co, x) => ["update leave_requests set approver_id = $2 where id = $1", [co.requestId, x]] },
  { name: "leave_requests.user_id, changed", target: person, missing: newPerson, write: (co, x) => ["update leave_requests set user_id = $2 where id = $1", [co.requestId, x]] },
  { name: "leave_request_days.request_id", target: (o) => o.requestId, missing: newId, write: (_co, x) => ["insert into leave_request_days (request_id, year, days) values ($1, 2042, 1)", [x]] },
  { name: "user.manager_id", target: person, missing: newPerson, write: (co, x) => ['update "user" set manager_id = $2 where id = $1', [co.userId, x]] },
  {
    name: "user.manager_id, new person",
    target: person,
    missing: newPerson,
    write: (co, x) => ["insert into \"user\" (id, name, email, company_id, manager_id) values ($2, 'N', $3, $1, $4)", [co.companyId, randomUUID(), `${randomUUID()}@example.com`, x]],
  },
  { name: "user.department_id", target: (o) => o.departmentId, missing: newId, write: (co, x) => ['update "user" set department_id = $2 where id = $1', [co.userId, x]] },
  { name: "user.level_id", target: (o) => o.levelId, missing: newId, write: (co, x) => ['update "user" set level_id = $2 where id = $1', [co.userId, x]] },
  {
    name: "user.scrub_requested_by",
    target: person,
    missing: newPerson,
    write: (co, x) => ['update "user" set is_active = false, scrub_scheduled_at = now(), scrub_requested_by = $2 where id = $1', [co.userId, x]],
  },
  { name: "departments.manager_id", target: person, missing: newPerson, write: (co, x) => ["update departments set manager_id = $2 where id = $1", [co.departmentId, x]] },
  {
    name: "allowance_rules.leave_type_id",
    target: (o) => o.leaveTypeId,
    missing: newId,
    write: (co, x) => ["insert into allowance_rules (company_id, leave_type_id, level_id, days) values ($1, $2, $3, 4)", [co.companyId, x, co.levelId]],
  },
  {
    name: "allowance_rules.department_id",
    target: (o) => o.departmentId,
    missing: newId,
    write: (co, x) => ["update allowance_rules set department_id = $2 where company_id = $1", [co.companyId, x]],
  },
  {
    name: "allowance_rules.level_id",
    target: (o) => o.levelId,
    missing: newId,
    write: (co, x) => ["insert into allowance_rules (company_id, leave_type_id, level_id, days) values ($1, $2, $3, 4)", [co.companyId, co.leaveTypeId, x]],
  },
  { name: "allowances.user_id", target: person, missing: newPerson, write: (co, x) => ["insert into allowances (user_id, leave_type_id, year, days) values ($1, $2, 2046, 1)", [x, co.leaveTypeId]] },
  {
    name: "allowances.leave_type_id",
    target: (o) => o.leaveTypeId,
    missing: newId,
    write: (co, x) => ["insert into allowances (user_id, leave_type_id, year, days) values ($1, $2, 2045, 1)", [co.userId, x]],
  },
  {
    name: "calendar_feed_tokens.user_id",
    target: person,
    missing: newPerson,
    write: (co, x) => ["insert into calendar_feed_tokens (company_id, user_id, kind, token_hash) values ($1, $2, 'team', $3)", [co.companyId, x, hex64()]],
  },
  {
    name: "calendar_feed_tokens.user_id, changed",
    target: person,
    missing: newPerson,
    write: (co, x) => ["update calendar_feed_tokens set user_id = $2 where company_id = $1", [co.companyId, x]],
  },
  { name: "webhook_deliveries.endpoint_id", target: (o) => o.endpointId, missing: newId, write: (co, x) => [delivery, [co.companyId, x, co.eventId]] },
  {
    name: "adapter_deliveries.event_id",
    target: (o) => o.eventId,
    missing: newId,
    write: (co, x) => ["insert into adapter_deliveries (company_id, adapter_id, event_id, next_attempt_at) values ($1, $2, $3, now())", [co.companyId, `a-${randomUUID()}`, x]],
  },
  {
    name: "api_keys.created_by",
    target: person,
    missing: newPerson,
    write: (co, x) => ["insert into api_keys (company_id, name, prefix, key_hash, created_by) values ($1, 'k', 'ooohm_x', $3, $2)", [co.companyId, x, hex64()]],
  },
  {
    name: "webhook_endpoints.created_by",
    target: person,
    missing: newPerson,
    write: (co, x) => [
      "insert into webhook_endpoints (id, company_id, url, event_types, secret_ciphertext, created_by) values ($3, $1, 'https://example.com', '{x}', 'v1', $2)",
      [co.companyId, x, randomUUID()],
    ],
  },
  { name: "audit_log.actor_id", target: person, missing: newPerson, write: (co, x) => [audit("actor_kind, actor_id", "'user', $2"), [co.companyId, x]] },
  {
    name: "audit_log.actor_requested_by",
    target: person,
    missing: newPerson,
    write: (co, x) => [audit("actor_kind, actor_process, actor_requested_by", "'system', 'test', $2"), [co.companyId, x]],
  },
  {
    name: "audit_log.subject_user_id",
    target: person,
    missing: newPerson,
    write: (co, x) => [audit("actor_kind, actor_process, subject_user_id", "'system', 'test', $2"), [co.companyId, x]],
  },
  {
    name: "audit_log.api_key_id",
    target: (o) => o.apiKeyId,
    missing: newId,
    write: (co, x) => [audit("actor_kind, actor_id, api_key_id", "'api_key', $3, $2"), [co.companyId, x, co.userId]],
  },
  {
    name: "session.user_id",
    target: person,
    missing: newPerson,
    write: (_co, x) => ["insert into session (id, expires_at, token, user_id) values ($1, now(), $2, $3)", [randomUUID(), randomUUID(), x]],
  },
  {
    name: "account.user_id",
    target: person,
    missing: newPerson,
    write: (_co, x) => ["insert into account (id, account_id, provider_id, user_id) values ($1, $2, 'google', $3)", [randomUUID(), randomUUID(), x]],
  },
  {
    name: "passkey.user_id",
    target: person,
    missing: newPerson,
    write: (_co, x) => [
      "insert into passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up) values ($1, 'k', $3, $2, 0, 'singleDevice', false)",
      [randomUUID(), randomUUID(), x],
    ],
  },
];

/** The tables whose rows a company owns, as the migrations' policies cover them: the cases above, in the database's own catalog. */
const TENANT_TABLES = CASES.map((c) => c.table).sort();

describe("row-level security", { skip }, () => {
  let t: TestDatabase;
  let a: Seeded;
  let b: Seeded;

  before(async () => {
    t = await createTestDatabase();
    a = await seed(t);
    b = await seed(t);
  });
  after(async () => {
    await t?.drop();
  });

  const count = (q: RawQuery, table: string, where = "true", params: unknown[] = []) =>
    q<{ n: number }>(`select count(*)::int as n from "${table}" where ${where}`, params).then((r) => Number(r.rows[0]?.n));

  test("services' role is neither a superuser nor exempt from row security", async () => {
    const [role] = await t.asApp(null, (q) => q<{ rolsuper: boolean; rolbypassrls: boolean }>("select rolsuper, rolbypassrls from pg_roles where rolname = current_user").then((r) => r.rows));
    assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  });

  test("every tenant table has row security enabled and forced, with a policy for each operation", async () => {
    const rows = await t.query<{ relname: string; enabled: boolean; forced: boolean; cmds: string[] }>`
      select c.relname, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
             coalesce(array_agg(distinct p.polcmd::text) filter (where p.polcmd is not null), '{}') as cmds
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      left join pg_policy p on p.polrelid = c.oid
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
      group by c.relname, c.relrowsecurity, c.relforcerowsecurity
      order by c.relname`;
    assert.deepEqual(
      rows.map((r) => r.relname),
      TENANT_TABLES,
      "the tables with row security are exactly the tenant tables",
    );
    for (const r of rows) {
      assert.ok(r.forced, `${r.relname} forces row security`);
      // r = SELECT, a = INSERT, w = UPDATE, d = DELETE, * = ALL (the owner's)
      assert.deepEqual([...r.cmds].sort(), ["*", "a", "d", "r", "w"], `${r.relname} has a policy per operation`);
    }
    const withCompany = await t.query<{ table_name: string }>`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'company_id'
        and table_name in (select relname from pg_class where relkind = 'r')`;
    for (const { table_name } of withCompany) assert.ok(TENANT_TABLES.includes(table_name), `${table_name} has company_id, so it is a tenant table`);
  });

  for (const c of CASES) {
    describe(c.table, () => {
      test("with company A's tenant: A's rows only, and B's cannot be changed, deleted or written", async () => {
        const [whereA, paramA] = c.rowsOf(a);
        const [whereB, paramB] = c.rowsOf(b);
        assert.ok((await t.asApp(a.companyId, (q) => count(q, c.table, whereA, [paramA]))) > 0, "A sees its own rows");
        assert.equal(await t.asApp(a.companyId, (q) => count(q, c.table, whereB, [paramB])), 0, "A sees none of B's");
        const [allA, idA] = ownedBy(c, a);
        assert.equal(await t.asApp(a.companyId, (q) => count(q, c.table)), await ownerCount(t, c.table, allA, idA), "exactly A's rows");

        if (c.appendOnly) {
          await assert.rejects(t.asApp(a.companyId, (q) => q(`update "${c.table}" set ${c.touch} where ${whereB}`, [paramB])), REFUSED);
          await assert.rejects(t.asApp(a.companyId, (q) => q(`delete from "${c.table}" where ${whereB}`, [paramB])), REFUSED);
        } else {
          assert.equal((await t.asApp(a.companyId, (q) => q(`update "${c.table}" set ${c.touch} where ${whereB}`, [paramB]))).count, 0, "updates none of B's");
          assert.equal((await t.asApp(a.companyId, (q) => q(`delete from "${c.table}" where ${whereB}`, [paramB]))).count, 0, "deletes none of B's");
          // WITH CHECK: one of A's rows cannot be handed to B.
          const [set, to] = c.moveTo(b);
          await assert.rejects(t.asApp(a.companyId, (q) => q(`update "${c.table}" set ${set} where ${whereA}`, [paramA, to])), REFUSED, "cannot move a row to B");
        }
        const [insertB, paramsB] = c.insert(b);
        await assert.rejects(t.asApp(a.companyId, (q) => q(insertB, paramsB)), REFUSED, "cannot write a row for B");
        const [insertA, paramsA] = c.insert(a);
        if (c.table === "companies") {
          await assert.rejects(t.asApp(a.companyId, (q) => q(insertA, paramsA)), { code: "23505" }, "A's own id is taken: the policy let it through");
        } else {
          assert.equal((await t.asApp(a.companyId, (q) => q(insertA, paramsA))).count, 1, "writes a row for A");
        }
        assert.ok((await ownerCount(t, c.table, whereB, paramB)) > 0, "B's rows are still there");
      });

      test("with no tenant: nothing visible, nothing written", async () => {
        const [whereA, paramA] = c.rowsOf(a);
        assert.equal(await t.asApp(null, (q) => count(q, c.table)), 0, "sees no row");
        if (!c.appendOnly) {
          assert.equal((await t.asApp(null, (q) => q(`update "${c.table}" set ${c.touch} where ${whereA}`, [paramA]))).count, 0, "updates none");
          assert.equal((await t.asApp(null, (q) => q(`delete from "${c.table}" where ${whereA}`, [paramA]))).count, 0, "deletes none");
        }
        const [insert, params] = c.insert(a);
        await assert.rejects(t.asApp(null, (q) => q(insert, params)), REFUSED, "cannot write");
        // An empty setting is no tenant either.
        assert.equal(await t.asApp("", (q) => count(q, c.table)), 0, "an empty tenant sees no row");
      });

      test("the owner sees both companies", async () => {
        const [whereA, paramA] = c.rowsOf(a);
        const [whereB, paramB] = c.rowsOf(b);
        assert.ok((await ownerCount(t, c.table, whereA, paramA)) > 0);
        assert.ok((await ownerCount(t, c.table, whereB, paramB)) > 0);
      });
    });
  }

  test("a pre-tenant lookup finds its row with no tenant set, and nothing else", async () => {
    const [key] = await t.query<{ key_hash: string }>`select key_hash from api_keys where company_id = ${a.companyId} limit 1`;
    assert.ok(key);
    const found = await t.asApp(null, (q) => q<{ company_id: string }>("select company_id from ooohm_api_key_for_hash($1)", [key.key_hash]));
    assert.deepEqual(found.rows, [{ company_id: a.companyId }]);
    assert.equal((await t.asApp(null, (q) => q("select * from ooohm_api_key_for_hash($1)", [hex64()]))).count, 0);
  });

  test("a member's own calendar link from a company they left can be seen and revoked from their new one, and nothing more", async () => {
    // A person now in B, with a live link issued while they were in A.
    const mover = randomUUID();
    await t.ownerQuery('insert into "user" (id, name, email, company_id) values ($1, \'M\', $2, $3)', [mover, `${mover}@example.com`, b.companyId]);
    const [link] = await t.ownerQuery<{ id: string }>(
      "insert into calendar_feed_tokens (company_id, user_id, kind, token_hash) values ($1, $2, 'team', $3) returning id",
      [a.companyId, mover, hex64()],
    );
    assert.ok(link);
    const seen = await t.asApp(b.companyId, (q) => q("select id from calendar_feed_tokens where id = $1", [link.id]));
    assert.equal(seen.count, 1, "B sees its member's link from A");
    await assert.rejects(
      t.asApp(b.companyId, (q) => q("update calendar_feed_tokens set company_id = $2 where id = $1", [link.id, b.companyId])),
      REFUSED,
      "B cannot move it into B, which would revive it",
    );
    const revoked = await t.asApp(b.companyId, (q) => q("update calendar_feed_tokens set revoked_at = now() where id = $1", [link.id]));
    assert.equal(revoked.count, 1, "B can turn it off");
    await assert.rejects(
      t.asApp(b.companyId, (q) => q("update calendar_feed_tokens set revoked_at = null where id = $1", [link.id])),
      REFUSED,
      "B cannot turn it back on",
    );
    const elsewhere = await t.asApp(b.companyId, (q) => q("select id from calendar_feed_tokens where company_id = $1 and user_id <> $2", [a.companyId, mover]));
    assert.equal(elsewhere.count, 0, "A's other links stay hidden from B");
  });

  test("the audit erasure functions act only inside the caller's tenant", async () => {
    const erased = await t.asApp(a.companyId, (q) => q<{ n: number }>("select ooohm_erase_audit_about($1, $2) as n", [b.companyId, b.userId]));
    assert.equal(Number(erased.rows[0]?.n), 0, "B's audit rows stay, whatever A's admin asks");
    assert.ok((await ownerCount(t, "audit_log", "company_id = $1", b.companyId)) > 0);
  });

  describe("references to another company's rows (drizzle/0032)", () => {
    for (const ref of REFERENCES) {
      test(`${ref.name}: another company's id and a missing one get the same refusal`, async () => {
        const [text, params] = ref.write(a, ref.target(b));
        await assert.rejects(t.asApp(a.companyId, (q) => q(text, params)), REFUSED, "another company's id");
        const [missing, missingParams] = ref.write(a, ref.missing());
        await assert.rejects(t.asApp(a.companyId, (q) => q(missing, missingParams)), REFUSED, "a missing id: no existence probe");
      });
    }

    test("a company's own references still go through", async () => {
      const managed = await t.asApp(a.companyId, (q) =>
        q('update "user" set manager_id = $2, department_id = $3, level_id = $4 where id = $1', [a.userId, a.userId, a.departmentId, a.levelId]),
      );
      assert.equal(managed.count, 1);
      const approver = await t.asApp(a.companyId, (q) => q("update leave_requests set approver_id = $2 where id = $1", [a.requestId, a.userId]));
      assert.equal(approver.count, 1);
      const audited = await t.asApp(a.companyId, (q) =>
        q("insert into audit_log (company_id, action, entity_type, entity_id, actor_kind, actor_id, subject_user_id) values ($1, 'x', 'x', 'x', 'user', $2, $2)", [
          a.companyId,
          a.userId,
        ]),
      );
      assert.equal(audited.count, 1);
      await t.ownerQuery('update "user" set manager_id = null, department_id = null, level_id = null where id = $1', [a.userId]);
      await t.ownerQuery("update leave_requests set approver_id = null where id = $1", [a.requestId]);
    });
  });

  describe("Better Auth's tables (drizzle/0032)", () => {
    test("the owner's views of them are gone", async () => {
      for (const view of ["auth_user", "auth_session", "auth_account", "auth_passkey"]) {
        await assert.rejects(t.asApp(null, (q) => q(`select * from ${view}`)), { code: "42P01" }, view);
      }
    });

    test("with no tenant, no person, session token or account token can be read, and no session written", async () => {
      assert.equal((await t.asApp(null, (q) => q('select email, role from "user"'))).count, 0);
      assert.equal((await t.asApp(null, (q) => q("select token from session"))).count, 0);
      assert.equal((await t.asApp(null, (q) => q("select access_token, refresh_token, id_token from account"))).count, 0);
      await assert.rejects(
        t.asApp(null, (q) => q("insert into session (id, expires_at, token, user_id) values ($1, now() + interval '1 day', $2, $3)", [randomUUID(), randomUUID(), b.userId])),
        REFUSED,
      );
    });

    test("with company A's tenant, B's people and sessions cannot be promoted, moved, forged or ended", async () => {
      assert.equal((await t.asApp(a.companyId, (q) => q("update \"user\" set role = 'admin' where id = $1", [b.userId]))).count, 0, "no admin for B");
      assert.equal((await t.asApp(a.companyId, (q) => q('update "user" set company_id = $2 where id = $1', [b.userId, a.companyId]))).count, 0, "no move into A");
      await assert.rejects(
        t.asApp(a.companyId, (q) =>
          q("insert into session (id, expires_at, token, user_id) values ($1, now() + interval '1 day', $2, $3)", [randomUUID(), randomUUID(), b.userId]),
        ),
        REFUSED,
        "no forged session for B's person",
      );
      assert.equal((await t.asApp(a.companyId, (q) => q("delete from session where user_id = $1", [b.userId]))).count, 0, "B's sessions stay");
      const [person] = await t.ownerQuery<{ role: string; company_id: string }>('select role, company_id from "user" where id = $1', [b.userId]);
      assert.deepEqual(person, { role: "employee", company_id: b.companyId });
      assert.ok((await ownerCount(t, "session", "user_id = $1", b.userId)) > 0);
    });

    test("the sign-in lookups find a company by a person, a session token, an account or a passkey, and nothing else", async () => {
      const [session] = await t.ownerQuery<{ token: string }>("select token from session where user_id = $1", [a.userId]);
      const [account] = await t.ownerQuery<{ id: string; account_id: string; provider_id: string }>("select id, account_id, provider_id from account where user_id = $1", [
        a.userId,
      ]);
      const [passkey] = await t.ownerQuery<{ id: string; credential_id: string }>("select id, credential_id from passkey where user_id = $1", [a.userId]);
      const [person] = await t.ownerQuery<{ email: string }>('select email from "user" where id = $1', [a.userId]);
      assert.ok(session && account && passkey && person);
      const rows = (text: string, params: unknown[]) => t.asApp(null, (q) => q(text, params)).then((r) => r.rows);
      const active = [{ company_id: a.companyId, is_active: true }];
      assert.deepEqual(await rows("select * from ooohm_auth_person($1, null)", [a.userId]), active);
      assert.deepEqual(await rows("select * from ooohm_auth_person(null, $1)", [person.email]), active);
      assert.deepEqual(await rows("select ooohm_auth_session_company($1) as c", [session.token]), [{ c: a.companyId }]);
      assert.deepEqual(await rows("select ooohm_auth_account_company($1, null, null) as c", [account.id]), [{ c: a.companyId }]);
      assert.deepEqual(await rows("select ooohm_auth_account_company(null, $1, $2) as c", [account.provider_id, account.account_id]), [{ c: a.companyId }]);
      assert.deepEqual(await rows("select ooohm_auth_passkey_company($1, null) as c", [passkey.id]), [{ c: a.companyId }]);
      assert.deepEqual(await rows("select ooohm_auth_passkey_company(null, $1) as c", [passkey.credential_id]), [{ c: a.companyId }]);
      assert.deepEqual(await rows("select ooohm_auth_session_company($1) as c", [randomUUID()]), [{ c: null }]);
      assert.deepEqual(await rows("select * from ooohm_auth_person(null, $1)", ["nobody@example.com"]), []);
    });

    test("every view the app role can use reads as its caller, and none takes its writes", async () => {
      // A view the owner adds later gets rights from the grants refresh only if it reads as its caller.
      await t.ownerQuery("create view rls_probe_owner_view as select id from companies");
      await t.ownerQuery("create view rls_probe_invoker_view with (security_invoker) as select id from companies");
      try {
        await t.migrate();
        const views = await t.asApp(null, (q) =>
          q<{ relname: string; invoker: boolean; reads: boolean; writes: boolean }>(`
            select c.relname,
                   coalesce((select option_value::boolean from pg_options_to_table(c.reloptions) where option_name = 'security_invoker'), false) as invoker,
                   has_table_privilege(current_user, c.oid, 'SELECT') as reads,
                   has_table_privilege(current_user, c.oid, 'INSERT') or has_table_privilege(current_user, c.oid, 'UPDATE')
                     or has_table_privilege(current_user, c.oid, 'DELETE') or has_table_privilege(current_user, c.oid, 'TRUNCATE') as writes
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('v', 'm')
            order by c.relname`),
        );
        const usable = views.rows.filter((v) => v.reads || v.writes);
        assert.deepEqual(
          usable.filter((v) => !v.invoker && !VIEWS_READ_AS_OWNER.includes(v.relname)).map((v) => v.relname),
          [],
          "a view the app role can use reads as its caller (security_invoker) or is listed",
        );
        assert.deepEqual(
          views.rows.filter((v) => v.writes).map((v) => v.relname),
          [],
          "the app role writes through no view",
        );
        assert.ok(
          usable.some((v) => v.relname === "rls_probe_invoker_view"),
          "an invoker view stays readable",
        );
      } finally {
        await t.ownerQuery("drop view rls_probe_owner_view");
        await t.ownerQuery("drop view rls_probe_invoker_view");
      }
    });
  });

  describe("narrow pre-tenant lookups (drizzle/0032)", () => {
    test("the email check answers with the addresses in use only", async () => {
      const [person] = await t.ownerQuery<{ email: string }>('select email from "user" where id = $1', [b.userId]);
      assert.ok(person);
      const found = await t.asApp(a.companyId, (q) => q("select * from ooohm_emails_in_use($1)", [[person.email, "nobody@example.com"]]));
      assert.deepEqual(found.rows, [{ email: person.email }], "no company id");
    });

    test("an approve link's person is found only for a request assigned to them", async () => {
      await t.ownerQuery("update leave_requests set approver_id = $2 where id = $1", [a.requestId, a.userId]);
      try {
        const link = (userId: string, requestId: string) => t.asApp(null, (q) => q("select * from ooohm_link_person($1, $2)", [userId, requestId]));
        assert.deepEqual((await link(a.userId, a.requestId)).rows, [{ id: a.userId, company_id: a.companyId, role: "employee", can_self_approve: false, is_active: true }]);
        assert.equal((await link(a.userId, b.requestId)).count, 0, "not their request");
        assert.equal((await link(b.userId, a.requestId)).count, 0, "not their assignment");
        assert.equal((await link(a.userId, randomUUID())).count, 0, "no such request");
      } finally {
        await t.ownerQuery("update leave_requests set approver_id = null where id = $1", [a.requestId]);
      }
    });
  });

  test("every outbox event names its company (drizzle/0032)", async () => {
    await assert.rejects(t.ownerQuery("insert into events_outbox (company_id, type, payload) values (null, 'x', '{}')"), { code: "23502" });
  });
});

/** Every row of `co` in the case's table, as the owner selects them: by company, or through the parent. */
function ownedBy(c: TableCase, co: Seeded): [where: string, param: string] {
  if (c.table === "companies") return ["id = $1", co.companyId];
  if (c.table === "leave_request_days") return ["request_id in (select id from leave_requests where company_id = $1)", co.companyId];
  if (["allowances", "session", "account", "passkey"].includes(c.table)) return ['user_id in (select id from "user" where company_id = $1)', co.companyId];
  return ["company_id = $1", co.companyId];
}

async function ownerCount(t: TestDatabase, table: string, where: string, param: string): Promise<number> {
  return t.ownerQuery(`select count(*)::int as n from "${table}" where ${where}`, [param]).then((rows) => Number(rows[0]?.n));
}

/** One company with a row in every tenant table, written as the owner. */
async function seed(t: TestDatabase): Promise<Seeded> {
  const one = async <R extends Record<string, unknown>>(text: string, params: unknown[]) => {
    const [row] = await t.ownerQuery<R>(text, params);
    if (!row) throw new Error(`no row from ${text}`);
    return row;
  };
  const companyId = (await one<{ id: string }>("insert into companies (name) values ($1) returning id", [`Co ${randomUUID()}`])).id;
  const userId = randomUUID();
  await one('insert into "user" (id, name, email, company_id) values ($1, \'P\', $2, $3) returning id', [userId, `${userId}@example.com`, companyId]);
  const departmentId = (await one<{ id: string }>("insert into departments (company_id, name) values ($1, 'Dev') returning id", [companyId])).id;
  const levelId = (await one<{ id: string }>("insert into levels (company_id, name) values ($1, 'Senior') returning id", [companyId])).id;
  await one("insert into email_templates (company_id, type, subject) values ($1, 'invite', 's') returning type", [companyId]);
  const leaveTypeId = (await one<{ id: string }>("insert into leave_types (company_id, name, code) values ($1, 'PTO', 'PTO') returning id", [companyId])).id;
  await one("insert into allowances (user_id, leave_type_id, year, days) values ($1, $2, 2026, 20) returning id", [userId, leaveTypeId]);
  await one("insert into allowance_rules (company_id, leave_type_id, department_id, days) values ($1, $2, $3, 10) returning id", [companyId, leaveTypeId, departmentId]);
  await one("insert into holidays (company_id, date, name) values ($1, '2026-12-25', 'Xmas') returning id", [companyId]);
  const requestId = (
    await one<{ id: string }>(
      "insert into leave_requests (company_id, user_id, leave_type_id, start_date, end_date, days) values ($1, $2, $3, '2026-11-16', '2026-11-16', 1) returning id",
      [companyId, userId, leaveTypeId],
    )
  ).id;
  await one("insert into leave_request_days (request_id, year, days) values ($1, 2026, 1) returning year", [requestId]);
  await one("insert into calendar_feed_tokens (company_id, user_id, kind, token_hash) values ($1, $2, 'personal', $3) returning id", [companyId, userId, hex64()]);
  await one("insert into audit_log (company_id, action, entity_type, entity_id, actor_kind, actor_process, subject_user_id) values ($1, 'x', 'user', $2, 'system', 'test', $2) returning id", [
    companyId,
    userId,
  ]);
  const eventId = (await one<{ id: string }>("insert into events_outbox (company_id, type, payload) values ($1, 'x', '{}') returning id", [companyId])).id;
  const endpointId = randomUUID();
  await one("insert into webhook_endpoints (id, company_id, url, event_types, secret_ciphertext) values ($1, $2, 'https://example.com', '{x}', 'v1') returning id", [endpointId, companyId]);
  await one("insert into webhook_deliveries (company_id, endpoint_id, event_id, event_type, body, next_attempt_at) values ($1, $2, $3, 'x', '{}', now()) returning id", [
    companyId,
    endpointId,
    eventId,
  ]);
  await one("insert into adapter_deliveries (company_id, adapter_id, event_id, next_attempt_at) values ($1, 'a', $2, now()) returning id", [companyId, eventId]);
  const apiKeyId = (await one<{ id: string }>("insert into api_keys (company_id, name, prefix, key_hash) values ($1, 'k', 'ooohm_x', $2) returning id", [companyId, hex64()])).id;
  await one("insert into import_runs (company_id, source, source_sha256, source_file_name, counts, report) values ($1, 'timeoff', $2, 'f.sqlite', '{}', '{}') returning id", [
    companyId,
    hex64(),
  ]);
  await one("insert into session (id, expires_at, token, user_id) values ($1, now(), $2, $3) returning id", [randomUUID(), randomUUID(), userId]);
  await one("insert into account (id, account_id, provider_id, user_id) values ($1, $2, 'google', $3) returning id", [randomUUID(), randomUUID(), userId]);
  await one("insert into passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up) values ($1, 'k', $2, $3, 0, 'singleDevice', false) returning id", [
    randomUUID(),
    userId,
    randomUUID(),
  ]);
  return { companyId, userId, leaveTypeId, departmentId, levelId, requestId, endpointId, eventId, apiKeyId };
}
