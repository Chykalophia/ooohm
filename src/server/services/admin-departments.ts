/**
 * Admin use cases for departments. A department is a name people can be grouped by
 * (the team view filters on it); it has no manager of its own, since approvals follow
 * each person's manager.
 */
import type { Actor } from "@/domain/actor";
import { assertCanAdminister } from "@/domain/admin-permissions";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES, type DepartmentEventPayload } from "@/domain/events";
import { isUuid } from "@/domain/ids";
import { normalizeDepartmentName } from "@/domain/people";
import type { ServiceContext } from "@/server/context";
import {
  type DepartmentRow,
  deleteDepartment as deleteDepartmentRow,
  findDepartmentByName,
  insertDepartment,
  listDepartmentsWithCounts,
  lockDepartment,
  renameDepartment as renameDepartmentRow,
} from "@/server/repositories/departments";
import { isUniqueViolation } from "@/server/repositories/errors";
import { countDepartmentMembers } from "@/server/repositories/users";
import { assertActiveAdmin, recordAdminChange } from "./admin-access";

function payload(row: DepartmentRow): Omit<DepartmentEventPayload, "actorId"> {
  return { departmentId: row.id, name: row.name };
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
 * The company's departments by name, with how many people (active or not) are in each.
 *
 * @throws DomainError `forbidden` for a non-admin.
 */
export async function listDepartmentsForAdmin(ctx: ServiceContext, actor: Actor) {
  assertCanAdminister(actor);
  return listDepartmentsWithCounts(ctx.db, actor.companyId);
}

/**
 * @throws DomainError `forbidden`, `invalid_input`, or `already_exists` (same name,
 *   ignoring case).
 */
export async function createDepartment(ctx: ServiceContext, actor: Actor, rawName: string): Promise<DepartmentRow> {
  assertCanAdminister(actor);
  const name = normalizeDepartmentName(rawName);
  return uniqueName(() =>
    ctx.db.transaction(async (tx) => {
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
    ctx.db.transaction(async (tx) => {
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
  await ctx.db.transaction(async (tx) => {
    await assertActiveAdmin(tx, actor);
    const before = await lockDepartment(tx, actor.companyId, id);
    if (!before) throw new DomainError("not_found");
    if ((await countDepartmentMembers(tx, id)) > 0) throw new DomainError("department_not_empty");
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
