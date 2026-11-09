/**
 * Admin use cases for departments. A department is a name people can be grouped by
 * (the team view filters on it), with an optional manager: approvals follow each
 * person's own manager, and fall back to their department's manager when they have none.
 */
import type { Actor } from "@/domain/actor";
import { assertCanAdminister } from "@/domain/admin-permissions";
import { DomainError } from "@/domain/errors";
import { MAX_OFF_LIMIT } from "@/domain/coverage";
import { ADMIN_EVENT_TYPES, type DepartmentEventPayload, type Unattributed } from "@/domain/events";
import { isUuid } from "@/domain/ids";
import { normalizeDepartmentName } from "@/domain/people";
import { personLabel } from "@/domain/person";
import type { ServiceContext } from "@/server/context";
import {
  type DepartmentRow,
  deleteDepartment as deleteDepartmentRow,
  findDepartmentByName,
  insertDepartment,
  listDepartmentsWithCounts,
  lockDepartment,
  renameDepartment as renameDepartmentRow,
  setDepartmentManagerRow,
  setDepartmentMaxOffRow,
} from "@/server/repositories/departments";
import { lockCompany } from "@/server/repositories/companies";
import { isUniqueViolation } from "@/server/repositories/errors";
import { listPendingRequestsInDepartment } from "@/server/repositories/leave-requests";
import { countDepartmentMembers, findMember, listPeopleNames } from "@/server/repositories/users";
import { assertActiveAdmin, recordAdminChange } from "./admin-access";
import { removeRulesOf } from "./admin-allowance-rules";
import { rerouteApprovals } from "./approval-routing";
import { commitThenNotify, inTransaction } from "./notify";

function payload(row: DepartmentRow): Unattributed<DepartmentEventPayload> {
  return { departmentId: row.id, name: row.name, managerId: row.managerId, maxOff: row.maxOff };
}

/** Runs `work`, turning a unique-name race into `already_exists`. */
async function uniqueName<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (isUniqueViolation(err, "departments_company_lower_name_uq")) throw new DomainError("already_exists");
    throw err;
  }
}

/**
 * The company's departments by name, with how many people (active or not) are in each
 * and who manages it (`managerId`, and `managerName` for its label), if anyone.
 *
 * @throws DomainError `forbidden` for a non-admin.
 */
export async function listDepartmentsForAdmin(ctx: ServiceContext, actor: Actor) {
  assertCanAdminister(actor);
  const rows = await listDepartmentsWithCounts(ctx.db, actor.companyId);
  return rows.map(({ managerEmail, managerName, ...row }) => ({
    ...row,
    managerName: row.managerId ? personLabel({ name: managerName ?? "", email: managerEmail ?? "" }) : null,
  }));
}

/**
 * Who may manage a department, for its manager picker: every active member, by name.
 *
 * @throws DomainError `forbidden` for a non-admin.
 */
export async function listDepartmentManagerChoices(ctx: ServiceContext, actor: Actor) {
  assertCanAdminister(actor);
  const names = await listPeopleNames(ctx.db, actor.companyId);
  return names.filter((n) => n.isActive).map((n) => ({ id: n.id, label: personLabel(n) }));
}

/**
 * @throws DomainError `forbidden`, `invalid_input`, or `already_exists` (same name,
 *   ignoring case).
 */
export async function createDepartment(ctx: ServiceContext, actor: Actor, rawName: string): Promise<DepartmentRow> {
  assertCanAdminister(actor);
  const name = normalizeDepartmentName(rawName);
  return uniqueName(() =>
    inTransaction(ctx, async (tx) => {
      await assertActiveAdmin(tx, actor);
      if (await findDepartmentByName(tx, actor.companyId, name)) throw new DomainError("already_exists");
      const row = await insertDepartment(tx, { companyId: actor.companyId, name });
      await recordAdminChange(tx, actor, {
        type: ADMIN_EVENT_TYPES.departmentCreated,
        entityType: "department",
        entityId: row.id,
        before: null,
        after: { name: row.name },
        payload: payload(row),
      });
      return row;
    }),
  );
}

/**
 * @throws DomainError `forbidden`, `not_found`, `invalid_input`, or `already_exists`.
 */
export async function renameDepartment(ctx: ServiceContext, actor: Actor, id: string, rawName: string): Promise<DepartmentRow> {
  assertCanAdminister(actor);
  if (!isUuid(id)) throw new DomainError("not_found");
  const name = normalizeDepartmentName(rawName);
  return uniqueName(() =>
    inTransaction(ctx, async (tx) => {
      await assertActiveAdmin(tx, actor);
      const before = await lockDepartment(tx, actor.companyId, id);
      if (!before) throw new DomainError("not_found");
      if (before.name === name) return before;
      if (await findDepartmentByName(tx, actor.companyId, name, id)) throw new DomainError("already_exists");
      const after = await renameDepartmentRow(tx, actor.companyId, id, name);
      await recordAdminChange(tx, actor, {
        type: ADMIN_EVENT_TYPES.departmentRenamed,
        entityType: "department",
        entityId: id,
        before: { name: before.name },
        after: { name: after.name },
        payload: payload(after),
      });
      return after;
    }),
  );
}

/**
 * Deletes an empty department. One with people in it (active or not) is refused rather
 * than emptied: emptying it would change each of those people with no audit row of
 * their own. Move them first; that is audited per person.
 *
 * The department row is locked first, so nobody can be moved into it between the
 * emptiness check and the delete.
 *
 * @throws DomainError `forbidden`, `not_found`, or `department_not_empty`.
 */
export async function deleteDepartment(ctx: ServiceContext, actor: Actor, id: string): Promise<void> {
  assertCanAdminister(actor);
  if (!isUuid(id)) throw new DomainError("not_found");
  await inTransaction(ctx, async (tx) => {
    // The company lock first, as rule changes take it, so a rule removed here is removed once.
    if (!(await lockCompany(tx, actor.companyId))) throw new DomainError("no_company");
    await assertActiveAdmin(tx, actor);
    const before = await lockDepartment(tx, actor.companyId, id);
    if (!before) throw new DomainError("not_found");
    if ((await countDepartmentMembers(tx, id)) > 0) throw new DomainError("department_not_empty");
    await removeRulesOf(tx, actor, { departmentId: id });
    await deleteDepartmentRow(tx, actor.companyId, id);
    await recordAdminChange(tx, actor, {
      type: ADMIN_EVENT_TYPES.departmentDeleted,
      entityType: "department",
      entityId: id,
      before: { name: before.name },
      after: null,
      payload: payload(before),
    });
  });
}

/** What setting a department's manager did. */
export interface DepartmentManagerResult extends DepartmentRow {
  /** Pending requests from the department's people that now wait on someone else. */
  requestsReassigned: number;
}

/**
 * Sets (or, with `null`, clears) the department's manager: any active member of the
 * company, whatever their role, since managing people is the reporting line and not
 * the role. Setting the manager it already has changes and records nothing.
 *
 * The department manager approves for its people who have no active manager of their
 * own, so the change re-routes the department's pending requests in the same
 * transaction (see `rerouteApprovals`): a request the rule now gives to someone else
 * moves, with its audit row, event and review email to the new approver after commit.
 * Taken under the company lock, as every change that moves approvals is.
 *
 * @throws DomainError `forbidden`, `not_found`, or `invalid_manager` (not an active
 *   member of the company).
 */
export async function setDepartmentManager(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  managerId: string | null,
): Promise<DepartmentManagerResult> {
  assertCanAdminister(actor);
  if (!isUuid(id)) throw new DomainError("not_found");
  return commitThenNotify(ctx, actor.companyId, async (tx) => {
    if (!(await lockCompany(tx, actor.companyId))) throw new DomainError("no_company");
    await assertActiveAdmin(tx, actor);
    const before = await lockDepartment(tx, actor.companyId, id);
    if (!before) throw new DomainError("not_found");
    // Unchanged is fine even for a manager since deactivated, so a form saved as it was never fails.
    if (before.managerId === managerId) return { result: { ...before, requestsReassigned: 0 }, notify: [] };
    if (managerId !== null && !(await findMember(tx, actor.companyId, managerId))?.isActive) throw new DomainError("invalid_manager");

    const after = await setDepartmentManagerRow(tx, actor.companyId, id, managerId);
    await recordAdminChange(tx, actor, {
      type: ADMIN_EVENT_TYPES.departmentManagerChanged,
      entityType: "department",
      entityId: id,
      before: { managerId: before.managerId },
      after: { managerId: after.managerId },
      payload: payload(after),
    });
    const { reassigned, notify } = await rerouteApprovals(ctx, tx, actor, await listPendingRequestsInDepartment(tx, actor.companyId, id));
    return { result: { ...after, requestsReassigned: reassigned }, notify };
  });
}

/**
 * Sets (or, with `null`, clears) the department's coverage limit: at most `maxOff` of its
 * people off on one working day. It only ever warns, the requester before sending and the
 * approver before deciding, so nothing already booked or waiting changes. Setting the
 * limit it already has changes and records nothing.
 *
 * @throws DomainError `forbidden`, `not_found`, or `invalid_input` (not a whole number
 *   from 1 to {@link MAX_OFF_LIMIT}).
 */
export async function setDepartmentLimit(ctx: ServiceContext, actor: Actor, id: string, maxOff: number | null): Promise<DepartmentRow> {
  assertCanAdminister(actor);
  if (!isUuid(id)) throw new DomainError("not_found");
  if (maxOff !== null && (!Number.isInteger(maxOff) || maxOff < 1 || maxOff > MAX_OFF_LIMIT)) throw new DomainError("invalid_input");
  return inTransaction(ctx, async (tx) => {
    await assertActiveAdmin(tx, actor);
    const before = await lockDepartment(tx, actor.companyId, id);
    if (!before) throw new DomainError("not_found");
    if (before.maxOff === maxOff) return before;
    const after = await setDepartmentMaxOffRow(tx, actor.companyId, id, maxOff);
    await recordAdminChange(tx, actor, {
      type: ADMIN_EVENT_TYPES.departmentLimitChanged,
      entityType: "department",
      entityId: id,
      before: { maxOff: before.maxOff },
      after: { maxOff: after.maxOff },
      payload: payload(after),
    });
    return after;
  });
}
