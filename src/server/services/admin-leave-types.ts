/**
 * Admin use cases for leave types: create, edit, archive and restore, reorder.
 *
 * Types are never deleted: requests and allowances reference them, and history must
 * keep its names. Archiving hides a type from the request form; existing requests,
 * calendars and balances (where the person has an allowance or booked days of it)
 * still show it, and the year rollover skips it. Settings that feed balances (the default
 * allowance, counting against allowance, carryover) apply to every balance computed
 * from then on, since balances are computed, not stored.
 */
import type { Actor } from "@/domain/actor";
import { assertCanAdminister } from "@/domain/admin-permissions";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES, type AdminEventType, type LeaveTypeEventPayload, type Unattributed } from "@/domain/events";
import { isUuid } from "@/domain/ids";
import { type LeaveTypeSettings, normalizeLeaveTypeSettings } from "@/domain/leave-type-settings";
import type { Transaction } from "@/db/types";
import type { ServiceContext } from "@/server/context";
import { lockCompany } from "@/server/repositories/companies";
import { isUniqueViolation } from "@/server/repositories/errors";
import {
  findLeaveTypeForAdmin,
  insertLeaveType,
  leaveTypeCodeTaken,
  type LeaveTypeRow,
  listAllLeaveTypes,
  nextLeaveTypeSortOrder,
  updateLeaveType as updateLeaveTypeRow,
} from "@/server/repositories/leave-types";
import { assertActiveAdmin, recordAdminChange } from "./admin-access";
import { inTransaction } from "./notify";

export type { LeaveTypeRow };

/** The audited view of a leave type. */
function snapshot(row: LeaveTypeRow) {
  return {
    name: row.name,
    code: row.code,
    color: row.color,
    isPaid: row.isPaid,
    countsAgainstAllowance: row.countsAgainstAllowance,
    defaultAllowanceDays: row.defaultAllowanceDays,
    carryoverEnabled: row.carryoverEnabled,
    carryoverMaxDays: row.carryoverMaxDays,
    sortOrder: row.sortOrder,
    archived: row.archivedAt !== null,
  };
}

function payload(row: LeaveTypeRow): Unattributed<LeaveTypeEventPayload> {
  return { leaveTypeId: row.id, ...snapshot(row) };
}

async function record(tx: Transaction, actor: Actor, type: AdminEventType, before: LeaveTypeRow | null, after: LeaveTypeRow) {
  await recordAdminChange(tx, actor, {
    type,
    entityType: "leave_type",
    entityId: after.id,
    before: before ? snapshot(before) : null,
    after: snapshot(after),
    payload: payload(after),
  });
}

/** Runs `work`, turning a code race into `already_exists`. */
async function uniqueCode<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (isUniqueViolation(err, "leave_types_company_code_uq")) throw new DomainError("already_exists");
    throw err;
  }
}

/**
 * Every leave type of the company: active ones in request-form order, then archived.
 *
 * @throws DomainError `forbidden` for a non-admin.
 */
export async function listLeaveTypesForAdmin(ctx: ServiceContext, actor: Actor): Promise<LeaveTypeRow[]> {
  assertCanAdminister(actor);
  return listAllLeaveTypes(ctx.db, actor.companyId);
}

/** @throws DomainError `forbidden` or `not_found`. */
export async function getLeaveTypeForAdmin(ctx: ServiceContext, actor: Actor, id: string): Promise<LeaveTypeRow> {
  assertCanAdminister(actor);
  if (!isUuid(id)) throw new DomainError("not_found");
  const row = await findLeaveTypeForAdmin(ctx.db, actor.companyId, id);
  if (!row) throw new DomainError("not_found");
  return row;
}

/**
 * Creates a leave type, last in the request form's order.
 *
 * @throws DomainError `forbidden`, `no_company`, `invalid_input`, or `already_exists` (the code is taken).
 */
export async function createLeaveType(ctx: ServiceContext, actor: Actor, input: LeaveTypeSettings): Promise<LeaveTypeRow> {
  assertCanAdminister(actor);
  const settings = normalizeLeaveTypeSettings(input);
  return uniqueCode(() =>
    inTransaction(ctx, async (tx) => {
      // Serialises creates, so two cannot take the same next sort order.
      if (!(await lockCompany(tx, actor.companyId))) throw new DomainError("no_company");
      await assertActiveAdmin(tx, actor);
      if (await leaveTypeCodeTaken(tx, actor.companyId, settings.code)) throw new DomainError("already_exists");
      const sortOrder = await nextLeaveTypeSortOrder(tx, actor.companyId);
      const row = await insertLeaveType(tx, { companyId: actor.companyId, sortOrder, ...settings });
      await record(tx, actor, ADMIN_EVENT_TYPES.leaveTypeCreated, null, row);
      return row;
    }),
  );
}

/**
 * Replaces a leave type's settings. Changing the code renames it on calendars and feeds;
 * changing a balance setting changes every balance computed from now on.
 *
 * @returns The type after the change (unchanged, with nothing recorded, when nothing differs).
 * @throws DomainError `forbidden`, `not_found`, `invalid_input`, or `already_exists`.
 */
export async function updateLeaveType(ctx: ServiceContext, actor: Actor, id: string, input: LeaveTypeSettings): Promise<LeaveTypeRow> {
  assertCanAdminister(actor);
  if (!isUuid(id)) throw new DomainError("not_found");
  const settings = normalizeLeaveTypeSettings(input);
  return uniqueCode(() =>
    inTransaction(ctx, async (tx) => {
      await assertActiveAdmin(tx, actor);
      const before = await findLeaveTypeForAdmin(tx, actor.companyId, id);
      if (!before) throw new DomainError("not_found");
      const changed = (Object.keys(settings) as (keyof LeaveTypeSettings)[]).some((k) => settings[k] !== before[k]);
      if (!changed) return before;
      if (settings.code !== before.code && (await leaveTypeCodeTaken(tx, actor.companyId, settings.code, id))) {
        throw new DomainError("already_exists");
      }
      const after = await updateLeaveTypeRow(tx, actor.companyId, id, settings);
      await record(tx, actor, ADMIN_EVENT_TYPES.leaveTypeUpdated, before, after);
      return after;
    }),
  );
}

/**
 * Archives (`archived: true`) or restores a leave type. Archived types leave the request
 * form; history, calendars and balances with an allowance or booked days keep showing
 * them. A restored type goes last.
 *
 * @returns The type after the change (unchanged, with nothing recorded, when already so).
 * @throws DomainError `forbidden`, `no_company`, or `not_found`.
 */
export async function setLeaveTypeArchived(ctx: ServiceContext, actor: Actor, id: string, archived: boolean): Promise<LeaveTypeRow> {
  assertCanAdminister(actor);
  if (!isUuid(id)) throw new DomainError("not_found");
  return inTransaction(ctx, async (tx) => {
    if (!(await lockCompany(tx, actor.companyId))) throw new DomainError("no_company");
    await assertActiveAdmin(tx, actor);
    const before = await findLeaveTypeForAdmin(tx, actor.companyId, id);
    if (!before) throw new DomainError("not_found");
    if ((before.archivedAt !== null) === archived) return before;
    const after = archived
      ? await updateLeaveTypeRow(tx, actor.companyId, id, { archivedAt: ctx.now() })
      : await updateLeaveTypeRow(tx, actor.companyId, id, { archivedAt: null, sortOrder: await nextLeaveTypeSortOrder(tx, actor.companyId) });
    await record(tx, actor, archived ? ADMIN_EVENT_TYPES.leaveTypeArchived : ADMIN_EVENT_TYPES.leaveTypeUnarchived, before, after);
    return after;
  });
}

/**
 * Moves an active leave type one place up or down in the request form, then numbers the
 * active types 0, 1, 2... in their new order. Each type whose position changed writes a
 * `leave_type.reordered` audit row and event. The first type is the form's default.
 *
 * @returns `false` when it was already first (up) or last (down); nothing changes then.
 * @throws DomainError `forbidden`, `no_company`, `not_found` (unknown or archived type), or `invalid_input`.
 */
export async function moveLeaveType(ctx: ServiceContext, actor: Actor, id: string, direction: "up" | "down"): Promise<boolean> {
  assertCanAdminister(actor);
  if (!isUuid(id)) throw new DomainError("not_found");
  if (direction !== "up" && direction !== "down") throw new DomainError("invalid_input");
  return inTransaction(ctx, async (tx) => {
    // Serialises reorders, so two at once cannot interleave their renumbering.
    if (!(await lockCompany(tx, actor.companyId))) throw new DomainError("no_company");
    await assertActiveAdmin(tx, actor);
    const active = (await listAllLeaveTypes(tx, actor.companyId)).filter((t) => t.archivedAt === null);
    const from = active.findIndex((t) => t.id === id);
    if (from === -1) throw new DomainError("not_found");
    const to = direction === "up" ? from - 1 : from + 1;
    if (to < 0 || to >= active.length) return false;
    const order = [...active];
    [order[from], order[to]] = [order[to], order[from]];
    for (const [position, before] of order.entries()) {
      if (before.sortOrder === position) continue;
      const after = await updateLeaveTypeRow(tx, actor.companyId, before.id, { sortOrder: position });
      await record(tx, actor, ADMIN_EVENT_TYPES.leaveTypeReordered, before, after);
    }
    return true;
  });
}
