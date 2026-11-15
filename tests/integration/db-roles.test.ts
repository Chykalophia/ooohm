import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import type { Database } from "@/db/types";
import { applyDatabaseRoles, migrateAsOwner } from "@/server/admin/db";
import { deactivatePerson } from "@/server/services/admin-people";
import { deletePerson } from "@/server/services/admin-people-deletion";
import { submitLeaveRequest } from "@/server/services/leave-requests";
import { seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, needsServer, skip, type TestDatabase } from "./harness";

/**
 * The owner and app roles (ADR-0006, deploy/db-roles.sql), on a Postgres server only:
 * embedded PGlite has a single built-in user. Roles belong to the whole server, so each
 * run makes its own pair, named after a random suffix, and drops them at the end.
 */

const baseUrl = process.env.TEST_DATABASE_URL ?? "";
const PERMISSION_DENIED = { code: "42501" };

interface Roles {
  owner: string;
  app: string;
  ownerPassword: string;
  appPassword: string;
}

function newRoles(): Roles {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  return { owner: `ooohm_owner_${suffix}`, app: `ooohm_app_${suffix}`, ownerPassword: `o-${suffix}`, appPassword: `a-${suffix}` };
}

function urlFor(database: string, user?: string, password?: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user;
    url.password = password ?? "";
  }
  return url.toString();
}

function connect(url: string): postgres.Sql {
  return postgres(url, { max: 2, onnotice: () => {} });
}

function drizzleOn(client: postgres.Sql): Database {
  return drizzle(client, { schema, casing: "snake_case" });
}

async function dropRoles(server: postgres.Sql, roles: Roles): Promise<void> {
  for (const role of [roles.app, roles.owner]) await server.unsafe(`drop role if exists "${role}"`);
}

/** Asserts what the app role can and cannot do on a migrated database. */
async function assertAppRoleLimits(app: postgres.Sql): Promise<void> {
  // No DDL.
  await assert.rejects(app`create table app_made (id int)`, PERMISSION_DENIED);
  await assert.rejects(app`alter table companies add column app_made text`, PERMISSION_DENIED);
  await assert.rejects(app`drop table holidays`, PERMISSION_DENIED);
  await assert.rejects(app`create index app_made_idx on companies (name)`, PERMISSION_DENIED);
  await assert.rejects(app`truncate audit_log`, PERMISSION_DENIED);

  // Ordinary DML on app tables.
  const [company] = await app`insert into companies (name) values ('Role Co') returning id`;
  await app`update companies set name = 'Role Co 2' where id = ${company.id}`;
  const [{ name }] = await app`select name from companies where id = ${company.id}`;
  assert.equal(name, "Role Co 2");

  // The audit log only grows.
  const [row] = await app`
    insert into audit_log (company_id, actor_kind, actor_process, action, entity_type, entity_id, after)
    values (${company.id}, 'system', 'db-roles test', 'test.inserted', 'company', ${company.id}, '{"n": 1}')
    returning id`;
  assert.ok(row.id);
  await assert.rejects(app`update audit_log set action = 'test.rewritten' where id = ${row.id}`, PERMISSION_DENIED);
  await assert.rejects(app`delete from audit_log where id = ${row.id}`, PERMISSION_DENIED);
  const [kept] = await app`select action from audit_log where id = ${row.id}`;
  assert.equal(kept.action, "test.inserted");

  // Deleting the company still cascades to its audit rows: referential actions run as the table's owner.
  await app`delete from companies where id = ${company.id}`;
  assert.equal((await app`select 1 from audit_log where id = ${row.id}`).length, 0);
}

describe("database roles: a fresh install (roles first, then migrations as the owner)", { skip: skip || needsServer }, () => {
  const roles = newRoles();
  const database = `ooohm_roles_${randomUUID().replaceAll("-", "")}`;
  let server: postgres.Sql;
  let app: postgres.Sql;
  let appDb: Database;

  before(async () => {
    server = connect(baseUrl);
    await server.unsafe(`create database "${database}"`);
    const superuser = connect(urlFor(database));
    try {
      await applyDatabaseRoles(superuser, { ownerRole: roles.owner, appRole: roles.app, ownerPassword: roles.ownerPassword, appPassword: roles.appPassword });
    } finally {
      await superuser.end();
    }
    const ownerUrl = urlFor(database, roles.owner, roles.ownerPassword);
    const appUrl = urlFor(database, roles.app, roles.appPassword);
    const migrated = await migrateAsOwner({ purpose: "db-roles test", source: { DATABASE_ADMIN_URL: ownerUrl, DATABASE_URL: appUrl, OOOHM_DB_APP_ROLE: roles.app } });
    assert.deepEqual([migrated.grants, migrated.warnings], ["applied", []]);
    app = connect(appUrl);
    appDb = drizzleOn(app);
  });

  after(async () => {
    await app?.end();
    await server?.unsafe(`drop database if exists "${database}" with (force)`);
    if (server) await dropRoles(server, roles);
    await server?.end();
  });

  test("the owner owns every table the migrations made", async () => {
    const owners = await app`select distinct tableowner from pg_tables where schemaname in ('public', 'drizzle')`;
    assert.deepEqual(owners.map((r) => r.tableowner), [roles.owner]);
  });

  test("the app role cannot change the schema or rewrite the audit log, and works with rows", async () => {
    await assertAppRoleLimits(app);
  });

  test("a leave request goes through the normal service over the app role's connection", async () => {
    const co = await seedCompany(appDb, { manager: { role: "manager" }, ana: { managerKey: "manager" } });
    const ctx = createTestContext(appDb);
    const req = await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-23", endDate: "2026-11-25", dayPortion: "full" });
    assert.equal(req.status, "pending");
    const audit = await appDb.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, req.id));
    assert.deepEqual(audit.map((a) => a.action), ["leave_request.requested"]);
  });

  test("deleting a person still erases and redacts their audit rows, through the owner's functions", async () => {
    const co = await seedCompany(appDb, { boss: { role: "admin", canSelfApprove: true }, zebulon: { managerKey: "boss" } });
    const ctx = createTestContext(appDb);
    const { boss, zebulon } = co.people;
    await submitLeaveRequest(ctx, zebulon, { leaveTypeId: co.pto, startDate: "2026-11-23", endDate: "2026-11-24", dayPortion: "full" });
    // A row about someone else that mentions them: it stays, with their address redacted.
    const [other] = await appDb
      .insert(schema.auditLog)
      .values({ companyId: co.companyId, actorKind: "system", actorProcess: "db-roles test", action: "test.note", entityType: "company", entityId: co.companyId, after: { note: `${zebulon.email} covers Friday` } })
      .returning();
    const about = and(eq(schema.auditLog.companyId, co.companyId), eq(schema.auditLog.subjectUserId, zebulon.id));
    assert.ok((await appDb.select().from(schema.auditLog).where(about)).length >= 1, "their request is on record");

    await deactivatePerson(ctx, boss, zebulon.id);
    const outcome = await deletePerson(ctx, boss, zebulon.id, { mode: "scrubbed", confirmName: "Zebulon" });
    assert.equal(outcome.outcome, "deleted");
    const left = await appDb.select().from(schema.auditLog).where(about);
    assert.deepEqual(left.map((a) => a.action), ["user.deleted"], "the rows about them are gone; only the delete is on record");
    const [redacted] = await appDb.select().from(schema.auditLog).where(eq(schema.auditLog.id, other.id));
    assert.ok(redacted, "the row about someone else stays");
    assert.ok(!JSON.stringify(redacted.after).includes(zebulon.email), JSON.stringify(redacted.after));
    assert.match(JSON.stringify(redacted.after), /covers Friday/);
  });
});

describe("database roles: an existing install (migrated as one role, then split)", { skip: skip || needsServer }, () => {
  const roles = newRoles();
  let t: TestDatabase;
  let server: postgres.Sql;
  let owner: postgres.Sql;
  let app: postgres.Sql;

  before(async () => {
    t = await createTestDatabase();
    server = connect(baseUrl);
    const setup = { ownerRole: roles.owner, appRole: roles.app, ownerPassword: roles.ownerPassword, appPassword: roles.appPassword };
    await applyDatabaseRoles(t.client, setup);
    // Idempotent: the compose `migrate` service runs it on every start.
    await applyDatabaseRoles(t.client, setup);
    const [{ name }] = await t.query<{ name: string }>`select current_database() as name`;
    owner = connect(urlFor(name, roles.owner, roles.ownerPassword));
    app = connect(urlFor(name, roles.app, roles.appPassword));
  });

  after(async () => {
    await app?.end();
    await owner?.end();
    await t?.drop();
    if (server) await dropRoles(server, roles);
    await server?.end();
  });

  test("everything the first role made now belongs to the owner: tables, sequences, types, functions, the journal", async () => {
    const notOwned = await t.query<{ kind: string; name: string }>`
      select 'relation' as kind, c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'drizzle') and c.relkind in ('r', 'p', 'v', 'm', 'S') and pg_get_userbyid(c.relowner) <> ${roles.owner}
      union all
      select 'type', t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public' and t.typtype = 'e' and pg_get_userbyid(t.typowner) <> ${roles.owner}
      union all
      select 'function', p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and pg_get_userbyid(p.proowner) <> ${roles.owner}`;
    assert.deepEqual([...notOwned], []);
  });

  test("the app role cannot change the schema or rewrite the audit log, and works with rows", async () => {
    await assertAppRoleLimits(app);
  });

  test("a table a later migration adds gets the app's grants by default, and the re-grant keeps audit_log insert-only", async () => {
    await owner`create table later_feature (id serial primary key, label text not null)`;
    await app`insert into later_feature (label) values ('works')`;
    await app`update later_feature set label = 'still works'`;
    await app`delete from later_feature`;

    // A migration that recreates the audit log would get full default grants; the re-grant
    // every `pnpm db:migrate` runs takes UPDATE and DELETE away again.
    await owner`create table audit_log_rebuilt (like audit_log including all)`;
    await owner`alter table audit_log rename to audit_log_old`;
    await owner`alter table audit_log_rebuilt rename to audit_log`;
    await applyDatabaseRoles(owner, { appRole: roles.app, grantsOnly: true });
    const [{ id }] = await app`insert into audit_log (actor_kind, actor_process, action, entity_type, entity_id) values ('system', 't', 'a', 'e', 'x') returning id`;
    await assert.rejects(app`update audit_log set action = 'b' where id = ${id}`, PERMISSION_DENIED);
    await assert.rejects(app`delete from audit_log where id = ${id}`, PERMISSION_DENIED);
  });

  test("an app role with powers that bypass the grants is refused", async () => {
    const strong = `ooohm_strong_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await server.unsafe(`create role "${strong}" login createdb`);
    try {
      await assert.rejects(applyDatabaseRoles(t.client, { ownerRole: roles.owner, appRole: strong }), /plain role/);
      await assert.rejects(applyDatabaseRoles(t.client, { ownerRole: roles.owner, appRole: roles.owner }), /must be different/);
    } finally {
      await server.unsafe(`drop role if exists "${strong}"`);
    }
  });
});
