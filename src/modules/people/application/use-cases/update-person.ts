import "server-only";
import type { Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES } from "@/domain/events";
import { yearInTimeZone } from "@/lib/dates";
import type { ServiceContext } from "@/server/context";
import { listPendingAssignedTo, listPendingRequestsOf, listPendingSelfRouted, rerouteApprovals } from "@/modules/approvals";
import { followDefaults, loadAllowanceDefaults } from "@/modules/balances";
import { commitThenNotify } from "@/modules/notifications";
import { beginAdminChange } from "@/modules/people/application/admin-change";
import { type PersonDTO, toPersonDTO } from "@/modules/people/application/dto";
import { recordPersonChange } from "@/modules/people/application/person-changes";
import { assertManagerFor, assertPlacement, normalizePersonInput, type PersonFields, type PersonInput } from "@/modules/people/application/person-input";
import { canManagePeople } from "@/modules/people/application/policies";
import { assertKeepsAnActiveAdmin } from "@/modules/people/domain/people";
import { listActiveAdmins, lockPerson, type PersonRow, updatePerson as updatePersonRow } from "@/shared/lib/db/members";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";

/** What an edit did. */
export interface PersonUpdateResult {
  person: PersonDTO;
  /** Pending requests that moved to another approver because of the edit. */
  requestsReassigned: number;
}

/**
 * Edits a person's name, department, level, manager, role and self-approval. Their email
 * is their sign-in identity and cannot be changed here.
 *
 * Approval rights follow the edit at once, in the same transaction ({@link pendingMovedBy}),
 * and each moved request writes `leave_request.reassigned` / `leave.reassigned`, its new
 * approver getting a review email after commit. A new department or level moves the
 * person's allowances that follow the defaults (`followDefaults`).
 *
 * @returns The person after the change (unchanged, with nothing recorded, when nothing
 *   differs). Fails with `forbidden`, `not_found`, `invalid_input`, `invalid_manager`,
 *   `manager_cycle`, or `last_admin` (demoting the last active admin).
 */
export async function updatePerson(ctx: ServiceContext, actor: Actor, userId: string, input: PersonInput): Promise<ServiceResult<PersonUpdateResult>> {
  if (!canManagePeople(actor)) return err("forbidden");
  return attempt(async () => {
    const fields = normalizePersonInput(input);
    return commitThenNotify(ctx, actor.companyId, async (tx) => {
      const company = await beginAdminChange(tx, actor);
      const before = await lockPerson(tx, actor.companyId, userId);
      if (!before) throw new DomainError("not_found");
      await assertEditAllowed(tx, actor, before, fields);

      const changed = (Object.keys(fields) as (keyof PersonFields)[]).filter((k) => fields[k] !== before[k]);
      if (changed.length === 0) return { result: { person: toPersonDTO(before), requestsReassigned: 0 }, notify: [] };
      const after = await applyEdit(tx, actor, before, fields, yearInTimeZone(company.timezone, ctx.now()));
      await recordPersonChange(tx, actor, { type: ADMIN_EVENT_TYPES.userUpdated, before, after });
      const { reassigned, notify } = await rerouteApprovals(ctx, tx, actor, await pendingMovedBy(tx, actor.companyId, before, after));
      return { result: { person: toPersonDTO(after), requestsReassigned: reassigned }, notify };
    });
  });
}

/** The edit's rules, under the company and member locks. */
async function assertEditAllowed(tx: Transaction, actor: Actor, before: PersonRow, fields: PersonFields): Promise<void> {
  await assertPlacement(tx, actor.companyId, fields);
  if (fields.managerId !== before.managerId) await assertManagerFor(tx, actor.companyId, before.id, fields.managerId);
  if (fields.role !== before.role) {
    const admins = await listActiveAdmins(tx, actor.companyId);
    assertKeepsAnActiveAdmin(
      { personId: before.id, before, after: { role: fields.role, isActive: before.isActive } },
      admins.map((a) => a.id),
    );
  }
}

/** Saves the edit, moving the allowances that follow the defaults when their department or level changes. */
async function applyEdit(tx: Transaction, actor: Actor, before: PersonRow, fields: PersonFields, fromYear: number): Promise<PersonRow> {
  const placed = before.departmentId !== fields.departmentId || (fields.levelId !== undefined && before.levelId !== fields.levelId);
  const defaultsBefore = placed ? await loadAllowanceDefaults(tx, actor.companyId, [before.id]) : null;
  const after = await updatePersonRow(tx, actor.companyId, before.id, fields);
  if (defaultsBefore) {
    await followDefaults(tx, actor, {
      userIds: [after.id],
      fromYear,
      before: defaultsBefore,
      after: await loadAllowanceDefaults(tx, actor.companyId, [after.id]),
    });
  }
  return after;
}

/**
 * The pending requests an edit moves to another approver:
 * - Demoting an admin re-routes the requests assigned to them by the approval rule
 *   (those whose requester they still manage stay), and their own: one they had routed
 *   to themself as the only admin moves to whoever the rule now picks.
 * - A new manager or department re-routes that person's own requests, so the new
 *   manager (or department manager, or the admin fallback) gets them.
 * - Promoting someone to admin re-routes every request an admin had routed to themself
 *   for want of another admin.
 */
async function pendingMovedBy(tx: Transaction, companyId: string, before: PersonRow, after: PersonRow) {
  const demoted = before.role === "admin" && after.role !== "admin";
  const moved = demoted || before.managerId !== after.managerId || before.departmentId !== after.departmentId;
  return [
    ...(demoted ? await listPendingAssignedTo(tx, companyId, after.id) : []),
    ...(moved ? await listPendingRequestsOf(tx, companyId, after.id) : []),
    ...(before.role !== "admin" && after.role === "admin" ? await listPendingSelfRouted(tx, companyId) : []),
  ];
}
