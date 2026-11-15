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
  await one("insert into api_keys (company_id, name, prefix, key_hash) values ($1, 'k', 'ooohm_x', $2) returning id", [companyId, hex64()]);
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
  return { companyId, userId, leaveTypeId, departmentId, levelId, requestId, endpointId, eventId };
}
