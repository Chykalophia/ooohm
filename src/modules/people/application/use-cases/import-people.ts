import "server-only";
import type { Transaction } from "@/db/types";
import type { Actor } from "@/shared/kernel/actor";
import { CHANGE_PROCESSES, through } from "@/shared/kernel/change-source";
import { DomainError } from "@/shared/kernel/errors";
import { ADMIN_EVENT_TYPES } from "@/shared/kernel/events";
import type { ServiceContext } from "@/server/context";
import { listPendingSelfRouted, rerouteApprovals } from "@/modules/approvals";
import { countRecentActions } from "@/modules/audit";
import { commitThenNotify, type Notification } from "@/modules/notifications";
import { addDepartment } from "@/modules/organisation";
import { beginAdminChange, inviteEmail, inviterName } from "@/modules/people/application/admin-change";
import { planPeopleFile, type PeopleImportPreview } from "@/modules/people/application/people-import-plan";
import { recordPersonChange } from "@/modules/people/application/person-changes";
import { canImportPeople } from "@/modules/people/application/policies";
import { creationOrder, type PlannedPerson } from "@/modules/people/domain/people-import";
import { recordAdminChange } from "@/shared/lib/admin-access";
import { isUniqueViolation } from "@/shared/lib/db/errors";
import { insertPerson, type PersonRow } from "@/shared/lib/db/members";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";

/** Most people one admin may add by import in {@link PEOPLE_IMPORT_WINDOW_MINUTES}. */
export const PEOPLE_IMPORT_HOURLY_LIMIT = 500;
export const PEOPLE_IMPORT_WINDOW_MINUTES = 60;

/** What an import did. */
export interface PeopleImportResult {
  added: number;
  skipped: number;
  departmentsCreated: number;
}

/**
 * Adds everyone the file lists who has no account yet, creating the departments it names
 * that the company does not have. All or nothing: one transaction under the company lock,
 * planning the file again there, so what it writes never rests on a stale preview; any
 * row with a problem refuses the whole file. Managers in the file are created before the
 * people who report to them. Each person and department is recorded as an invite and the
 * departments screen would (`user.created`, `department.created`), naming the admin
 * through the import (`via: "people_import"`). Importing an admin re-routes any request
 * an admin had routed to themself for want of another admin, as inviting one does.
 * Nothing goes through Better Auth's sign-up.
 *
 * @param input.sendInvites Email each new person a sign-in link after commit. Without it
 *   they can still sign in from the sign-in page, and an admin can send the invite later
 *   from their page.
 * @returns Fails with `forbidden`, `invalid_input` (an unreadable file, or any row with a
 *   problem: nothing is written), `rate_limited` (more than {@link PEOPLE_IMPORT_HOURLY_LIMIT}
 *   people imported in an hour), or `already_exists` (someone was added another way meanwhile).
 */
export async function importPeople(ctx: ServiceContext, actor: Actor, input: { csv: string; sendInvites: boolean }): Promise<ServiceResult<PeopleImportResult>> {
  if (!canImportPeople(actor)) return err("forbidden");
  const importer: Actor = { ...actor, source: through(actor.source, CHANGE_PROCESSES.peopleImport) };
  return attempt(async () => {
    try {
      return await commitThenNotify(ctx, actor.companyId, async (tx) => {
        const company = await beginAdminChange(tx, actor);
        const plan = assertImportable(await planPeopleFile(tx, actor.companyId, input.csv));
        const people = creationOrder(plan);
        if (people.length === 0) return { result: { added: 0, skipped: plan.skips, departmentsCreated: 0 }, notify: [] };
        await assertUnderImportLimit(tx, actor, people.length);
        const departmentIds = await createDepartments(tx, importer, plan.newDepartments);
        const created = await createPeople(ctx, tx, importer, people, departmentIds);
        const rerouted = created.some((p) => p.role === "admin") ? await rerouteApprovals(ctx, tx, importer, await listPendingSelfRouted(tx, actor.companyId)) : null;
        const invites: Notification[] = input.sendInvites ? await invitesFor(ctx, tx, actor, created, company.name) : [];
        return {
          result: { added: created.length, skipped: plan.skips, departmentsCreated: plan.newDepartments.length },
          notify: [...invites, ...(rerouted?.notify ?? [])],
        };
      });
    } catch (e) {
      // Someone was invited, or a department created, between the plan and the insert.
      if (isUniqueViolation(e)) throw new DomainError("already_exists");
      throw e;
    }
  });
}

/** @throws DomainError `invalid_input` when any row has a problem. */
function assertImportable(plan: PeopleImportPreview): PeopleImportPreview {
  if (plan.errors === 0) return plan;
  const problems = plan.errors === 1 ? "One row has a problem" : `${plan.errors} rows have problems`;
  throw new DomainError("invalid_input", `${problems}, so nobody was added. Fix the file and check it again.`);
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

/** Creates the file's new departments. @returns Their ids, by lowercased name. */
async function createDepartments(tx: Transaction, importer: Actor, names: readonly string[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const name of names) {
    const row = await addDepartment(tx, { companyId: importer.companyId, name });
    ids.set(name.toLowerCase(), row.id);
    await recordAdminChange(tx, importer, {
      type: ADMIN_EVENT_TYPES.departmentCreated,
      entityType: "department",
      entityId: row.id,
      before: null,
      after: { name: row.name },
      payload: { departmentId: row.id, name: row.name },
    });
  }
  return ids;
}

/** Creates the planned people in order, each recorded as `user.created`. */
async function createPeople(ctx: ServiceContext, tx: Transaction, importer: Actor, people: readonly PlannedPerson[], departmentIds: Map<string, string>): Promise<PersonRow[]> {
  const ids = new Map(people.map((p) => [p.email, ctx.ids.next()]));
  const created: PersonRow[] = [];
  for (const p of people) {
    const person = await insertPerson(tx, {
      id: ids.get(p.email)!,
      companyId: importer.companyId,
      email: p.email,
      name: p.name,
      role: p.role,
      departmentId: p.department ? (p.department.id ?? departmentIds.get(p.department.name.toLowerCase()) ?? null) : null,
      managerId: p.manager === null ? null : p.manager.kind === "member" ? p.manager.id : ids.get(p.manager.email)!,
      canSelfApprove: p.canSelfApprove,
    });
    await recordPersonChange(tx, importer, { type: ADMIN_EVENT_TYPES.userCreated, before: null, after: person });
    created.push(person);
  }
  return created;
}

async function invitesFor(ctx: ServiceContext, tx: Transaction, actor: Actor, people: readonly PersonRow[], companyName: string): Promise<Notification[]> {
  const from = await inviterName(tx, actor);
  return people.map((person) => inviteEmail(ctx, person, from, companyName));
}
