/**
 * Admin use cases for adding many people at once from a CSV file: a preview that says
 * what the file would do, and the import itself. The file's rules are in
 * `@/domain/people-import`.
 *
 * The import is all or nothing. It runs in one transaction under the company lock, and
 * plans the file again there, against the company as it is at that moment, so what it
 * writes never rests on a preview that has gone stale. Any row with a problem refuses the
 * whole file.
 *
 * Each person is created as an invite would create them (`user.created`), and each new
 * department as the departments screen would (`department.created`), with the audit row
 * and outbox event in the same transaction. All of them name the admin through the
 * import: `{ kind: "user", userId, via: "people_import" }`. Invite emails, when asked
 * for, go out only after commit. Access stays invite-only: nothing here goes through
 * Better Auth's sign-up.
 */
import { randomUUID } from "node:crypto";
import type { Executor, Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { assertCanAdminister } from "@/domain/admin-permissions";
import { CHANGE_PROCESSES, through } from "@/domain/change-source";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES } from "@/domain/events";
import { creationOrder, type ImportFacts, type PeopleImportPlan, planPeopleImport, readPeopleCsv } from "@/domain/people-import";
import type { ServiceContext } from "@/server/context";
import { countRecentActions } from "@/server/repositories/audit-log";
import { insertDepartment, listDepartments } from "@/server/repositories/departments";
import { isUniqueViolation } from "@/server/repositories/errors";
import { listPendingSelfRouted } from "@/server/repositories/leave-requests";
import { emailsInUse, insertPerson, listPeopleNames, type PersonRow } from "@/server/repositories/users";
import { assertActiveAdmin, recordAdminChange } from "./admin-access";
import { beginAdminChange, inviteEmail, inviterName, personPayload, personSnapshot } from "./admin-people";
import { rerouteApprovals } from "./approval-routing";
import { commitThenNotify, type Notification } from "./notify";

/** Most people one admin may add by import in {@link PEOPLE_IMPORT_WINDOW_MINUTES}. */
export const PEOPLE_IMPORT_HOURLY_LIMIT = 500;
export const PEOPLE_IMPORT_WINDOW_MINUTES = 60;

/** What an import did. */
export interface PeopleImportResult {
  added: number;
  skipped: number;
  departmentsCreated: number;
}

/** The facts a plan of `csv` needs, read with `ex`. */
async function loadFacts(ex: Executor, companyId: string, emails: readonly string[]): Promise<ImportFacts> {
  const [people, taken, departments] = await Promise.all([
    listPeopleNames(ex, companyId),
    emailsInUse(ex, emails),
    listDepartments(ex, companyId),
  ]);
  return {
    members: new Map(people.map((p) => [p.email, { id: p.id, isActive: p.isActive }])),
    takenEmails: taken,
    departments: new Map(departments.map((d) => [d.name.toLowerCase(), { id: d.id, name: d.name }])),
  };
}

/** A plan, with the headers of the file's columns that the import ignores. */
export type PeopleImportPreview = PeopleImportPlan & { ignoredColumns: string[] };

/** Reads the file and plans it against the company as `ex` sees it. */
async function planFile(ex: Executor, companyId: string, csv: string): Promise<PeopleImportPreview> {
  const { rows, ignoredColumns } = readPeopleCsv(csv);
  // Every address the file mentions, people and managers alike, lowercased as stored.
  const emails = [...new Set(rows.flatMap((r) => [r.email, r.managerEmail]).map((e) => e.trim().toLowerCase()).filter(Boolean))];
  return { ...planPeopleImport(rows, await loadFacts(ex, companyId, emails)), ignoredColumns };
}

/**
 * What importing `csv` would do, row by row. Writes nothing.
 *
 * @throws DomainError `forbidden` (not an active admin), or `invalid_input` with a
 *   message to show when the file cannot be read as an import file.
 */
export async function previewPeopleImport(ctx: ServiceContext, actor: Actor, csv: string): Promise<PeopleImportPreview> {
  assertCanAdminister(actor);
  await assertActiveAdmin(ctx.db, actor);
  return planFile(ctx.db, actor.companyId, csv);
}

/**
 * Counts the people the actor added by import in the window, under the company lock.
 *
 * @throws DomainError `rate_limited` when adding `adding` more would pass {@link PEOPLE_IMPORT_HOURLY_LIMIT}.
 */
async function assertUnderImportLimit(tx: Transaction, actor: Actor, adding: number): Promise<void> {
  const added = await countRecentActions(
    tx,
    { companyId: actor.companyId, actorId: actor.id, actions: [ADMIN_EVENT_TYPES.userCreated], via: CHANGE_PROCESSES.peopleImport },
    PEOPLE_IMPORT_WINDOW_MINUTES,
  );
  if (added + adding > PEOPLE_IMPORT_HOURLY_LIMIT) throw new DomainError("rate_limited");
}

/**
 * Adds everyone the file lists who has no account yet, creating the departments it names
 * that the company does not have. Managers in the file are created before the people who
 * report to them. Importing an admin re-routes any request an admin had routed to
 * themself for want of another admin, as inviting one does.
 *
 * @param input.sendInvites Email each new person a sign-in link after commit. Without it
 *   they can still sign in from the sign-in page, and an admin can send the invite later
 *   from their page.
 * @throws DomainError `forbidden`, `invalid_input` (an unreadable file, or any row with a
 *   problem: nothing is written), or `rate_limited` (more than
 *   {@link PEOPLE_IMPORT_HOURLY_LIMIT} people imported in an hour).
 */
export async function importPeople(
  ctx: ServiceContext,
  actor: Actor,
  input: { csv: string; sendInvites: boolean },
): Promise<PeopleImportResult> {
  assertCanAdminister(actor);
  const importer: Actor = { ...actor, source: through(actor.source, CHANGE_PROCESSES.peopleImport) };

  try {
    return await commitThenNotify(ctx, actor.companyId, async (tx) => {
      const company = await beginAdminChange(tx, actor);
      const plan = await planFile(tx, actor.companyId, input.csv);
      if (plan.errors > 0) {
        throw new DomainError(
          "invalid_input",
          `${plan.errors === 1 ? "One row has a problem" : `${plan.errors} rows have problems`}, so nobody was added. Fix the file and check it again.`,
        );
      }
      const people = creationOrder(plan);
      if (people.length === 0) return { result: { added: 0, skipped: plan.skips, departmentsCreated: 0 }, notify: [] };
      await assertUnderImportLimit(tx, actor, people.length);

      const departmentIds = new Map<string, string>();
      for (const name of plan.newDepartments) {
        const row = await insertDepartment(tx, { companyId: actor.companyId, name });
        departmentIds.set(name.toLowerCase(), row.id);
        await recordAdminChange(tx, importer, {
          type: ADMIN_EVENT_TYPES.departmentCreated,
          entityType: "department",
          entityId: row.id,
          before: null,
          after: { name: row.name },
          payload: { departmentId: row.id, name: row.name },
        });
      }

      const ids = new Map(people.map((p) => [p.email, randomUUID()]));
      const created: PersonRow[] = [];
      for (const p of people) {
        const person = await insertPerson(tx, {
          id: ids.get(p.email)!,
          companyId: actor.companyId,
          email: p.email,
          name: p.name,
          role: p.role,
          departmentId: p.department ? (p.department.id ?? departmentIds.get(p.department.name.toLowerCase()) ?? null) : null,
          managerId: p.manager === null ? null : p.manager.kind === "member" ? p.manager.id : ids.get(p.manager.email)!,
          canSelfApprove: p.canSelfApprove,
        });
        await recordAdminChange(tx, importer, {
          type: ADMIN_EVENT_TYPES.userCreated,
          entityType: "user",
          entityId: person.id,
          subjectUserId: person.id,
          before: null,
          after: personSnapshot(person),
          payload: personPayload(person),
        });
        created.push(person);
      }

      const rerouted = created.some((p) => p.role === "admin")
        ? await rerouteApprovals(ctx, tx, importer, await listPendingSelfRouted(tx, actor.companyId))
        : null;
      const invites: Notification[] = [];
      if (input.sendInvites) {
        const from = await inviterName(tx, actor);
        for (const person of created) invites.push(inviteEmail(ctx, person, from, company.name));
      }
      return {
        result: { added: created.length, skipped: plan.skips, departmentsCreated: plan.newDepartments.length },
        notify: [...invites, ...(rerouted?.notify ?? [])],
      };
    });
  } catch (err) {
    // Someone was invited, or a department created, between the plan and the insert.
    if (isUniqueViolation(err)) throw new DomainError("already_exists");
    throw err;
  }
}
