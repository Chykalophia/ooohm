/**
 * Admin use cases for allowance rules: a yearly allowance of one leave type for a
 * department, a level, or both, replacing the type's default for the people it matches
 * (the most specific rule wins: `@/domain/allowance-rules`).
 *
 * The year rollover gives everyone a row for the current year, so a rule that only
 * changed the default would reach nobody until next year. So a change also moves the
 * rows that were following the default: this year's and later rows whose `days` equal
 * what the rules gave that person before the change take what they give now
 * ({@link followDefaults}). A row an admin set to something else stays as it is.
 */
import type { Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { assertCanAdminister } from "@/domain/admin-permissions";
import { normalizeAllowanceRule, type Placement } from "@/domain/allowance-rules";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES, type AllowanceRuleEventPayload, type Unattributed } from "@/domain/events";
import { isUuid } from "@/domain/ids";
import { yearInTimeZone } from "@/lib/dates";
import type { ServiceContext } from "@/server/context";
import {
  type AllowanceRuleRow,
  deleteAllowanceRule,
  deleteAllowanceRulesOf,
  findAllowanceRule,
  findAllowanceRuleFor,
  insertAllowanceRule,
  listAllowanceRules,
  listMembersAt,
  updateAllowanceRuleDays,
} from "@/server/repositories/allowance-rules";
import { lockAllowancesFrom, setAllowanceDays } from "@/server/repositories/balances";
import { lockCompany } from "@/server/repositories/companies";
import { findDepartment, listDepartments } from "@/server/repositories/departments";
import { isUniqueViolation } from "@/server/repositories/errors";
import { findLeaveType, listAllLeaveTypes } from "@/server/repositories/leave-types";
import { findLevel, listLevels } from "@/server/repositories/levels";
import { lockMembers } from "@/server/repositories/users";
import { assertActiveAdmin, recordAdminChange } from "./admin-access";
import { recordAllowanceChange } from "./allowance-changes";
import { type AllowanceDefaults, loadAllowanceDefaults } from "./balances";
import { inTransaction } from "./notify";

export interface AllowanceRuleInput extends Placement {
  leaveTypeId: string;
  days: number;
}

export interface AllowanceRuleResult extends AllowanceRuleRow {
  /** People's allowance rows that were following the default and moved with the change. */
  allowancesUpdated: number;
}

function snapshot(rule: AllowanceRuleRow) {
  return { leaveTypeId: rule.leaveTypeId, departmentId: rule.departmentId, levelId: rule.levelId, days: rule.days };
}

function payload(rule: AllowanceRuleRow): Unattributed<AllowanceRuleEventPayload> {
  return { ruleId: rule.id, ...snapshot(rule) };
}

/**
 * One leave type's rules, with the names of their department and level, in the order
 * they were added.
 *
 * @throws DomainError `forbidden`.
 */
export async function listAllowanceRulesForAdmin(ctx: ServiceContext, actor: Actor, leaveTypeId: string) {
  return (await getAllowanceRulesForm(ctx, actor, leaveTypeId)).rules;
}

/**
 * What a leave type's rules card shows: its rules (named, as {@link listAllowanceRulesForAdmin})
 * and the departments and levels a new rule can name. Three queries, in parallel.
 *
 * @throws DomainError `forbidden`.
 */
export async function getAllowanceRulesForm(ctx: ServiceContext, actor: Actor, leaveTypeId: string) {
  assertCanAdminister(actor);
  const [rules, departments, levels] = await Promise.all([
    isUuid(leaveTypeId) ? listAllowanceRules(ctx.db, actor.companyId, leaveTypeId) : [],
    listDepartments(ctx.db, actor.companyId),
    listLevels(ctx.db, actor.companyId),
  ]);
  const departmentName = new Map(departments.map((d) => [d.id, d.name]));
  const levelName = new Map(levels.map((l) => [l.id, l.name]));
  return {
    rules: rules.map((r) => ({
      ...r,
      departmentName: r.departmentId ? (departmentName.get(r.departmentId) ?? null) : null,
      levelName: r.levelId ? (levelName.get(r.levelId) ?? null) : null,
    })),
    departments: departments.map(({ id, name }) => ({ id, name })),
    levels,
  };
}

/**
 * Sets the allowance of a leave type for a department, a level, or both: creates the
 * rule, or updates the days of the one for that exact target. Moves the matching
 * people's rows that were following the default ({@link followDefaults}).
 *
 * @throws DomainError `forbidden`, `invalid_input` (no target, or days out of range or
 *   finer than a tenth), or `not_found` (a leave type, department or level outside the
 *   actor's company).
 */
export async function setAllowanceRule(ctx: ServiceContext, actor: Actor, input: AllowanceRuleInput): Promise<AllowanceRuleResult> {
  assertCanAdminister(actor);
  const rule = normalizeAllowanceRule(input);
  for (const id of [input.leaveTypeId, rule.departmentId, rule.levelId]) if (id !== null && !isUuid(id)) throw new DomainError("not_found");
  try {
    return await inTransaction(ctx, async (tx) => {
      const year = await thisYear(ctx, tx, actor);
      const [type, department, level] = await Promise.all([
        findLeaveType(tx, actor.companyId, input.leaveTypeId),
        rule.departmentId ? findDepartment(tx, actor.companyId, rule.departmentId) : null,
        rule.levelId ? findLevel(tx, actor.companyId, rule.levelId) : null,
      ]);
      if (!type || department === undefined || level === undefined) throw new DomainError("not_found");

      const before = await findAllowanceRuleFor(tx, actor.companyId, input.leaveTypeId, rule);
      if (before && before.days === rule.days) return { ...before, allowancesUpdated: 0 };
      const userIds = await membersAt(tx, actor, rule);
      const defaultsBefore = await loadAllowanceDefaults(tx, actor.companyId, userIds);
      const after = before
        ? await updateAllowanceRuleDays(tx, actor.companyId, before.id, rule.days)
        : await insertAllowanceRule(tx, { companyId: actor.companyId, leaveTypeId: input.leaveTypeId, ...rule });
      await recordAdminChange(tx, actor, {
        type: ADMIN_EVENT_TYPES.allowanceRuleSet,
        entityType: "allowance_rule",
        entityId: after.id,
        before: before ? snapshot(before) : null,
        after: snapshot(after),
        payload: payload(after),
      });
      const allowancesUpdated = await followDefaults(tx, actor, {
        userIds,
        leaveTypeIds: [input.leaveTypeId],
        fromYear: year,
        before: defaultsBefore,
        after: await loadAllowanceDefaults(tx, actor.companyId, userIds),
      });
      return { ...after, allowancesUpdated };
    });
  } catch (err) {
    // Two admins adding the same rule at once: the loser reads it as already there.
    if (isUniqueViolation(err, "allowance_rules_target_uq")) throw new DomainError("conflict");
    throw err;
  }
}

/**
 * Removes a rule; its people go back to the next rule that matches them, or the type's
 * default, and rows that were following it move too ({@link followDefaults}).
 *
 * @throws DomainError `forbidden` or `not_found`.
 */
export async function removeAllowanceRule(ctx: ServiceContext, actor: Actor, id: string): Promise<{ allowancesUpdated: number }> {
  assertCanAdminister(actor);
  if (!isUuid(id)) throw new DomainError("not_found");
  return inTransaction(ctx, async (tx) => {
    const year = await thisYear(ctx, tx, actor);
    const before = await findAllowanceRule(tx, actor.companyId, id);
    if (!before) throw new DomainError("not_found");
    const userIds = await membersAt(tx, actor, before);
    const defaultsBefore = await loadAllowanceDefaults(tx, actor.companyId, userIds);
    await deleteAllowanceRule(tx, actor.companyId, id);
    await recordAdminChange(tx, actor, {
      type: ADMIN_EVENT_TYPES.allowanceRuleRemoved,
      entityType: "allowance_rule",
      entityId: id,
      before: snapshot(before),
      after: null,
      payload: payload(before),
    });
    const allowancesUpdated = await followDefaults(tx, actor, {
      userIds,
      leaveTypeIds: [before.leaveTypeId],
      fromYear: year,
      before: defaultsBefore,
      after: await loadAllowanceDefaults(tx, actor.companyId, userIds),
    });
    return { allowancesUpdated };
  });
}

/**
 * The people a rule's target matches, under their member locks: the year rollover reads
 * a member's defaults under that lock, so it either sees this change or finishes first
 * (and its new row is then moved here like any other).
 */
async function membersAt(tx: Transaction, actor: Actor, target: Placement): Promise<string[]> {
  const userIds = await listMembersAt(tx, actor.companyId, target);
  await lockMembers(tx, actor.companyId, userIds);
  return userIds;
}

/**
 * Removes every rule of a department or level about to be deleted, recording
 * `allowance_rule.removed` for each (the foreign key would drop them silently). Nobody
 * is placed there any more, so no allowance moves.
 */
export async function removeRulesOf(tx: Transaction, actor: Actor, target: { departmentId: string } | { levelId: string }): Promise<void> {
  for (const rule of await deleteAllowanceRulesOf(tx, actor.companyId, target)) {
    await recordAdminChange(tx, actor, {
      type: ADMIN_EVENT_TYPES.allowanceRuleRemoved,
      entityType: "allowance_rule",
      entityId: rule.id,
      before: snapshot(rule),
      after: null,
      payload: payload(rule),
    });
  }
}

/** Locks the company and checks the actor, then this year in the company's time zone. */
async function thisYear(ctx: ServiceContext, tx: Transaction, actor: Actor): Promise<number> {
  const company = await lockCompany(tx, actor.companyId);
  if (!company) throw new DomainError("no_company");
  await assertActiveAdmin(tx, actor);
  return yearInTimeZone(company.timezone, ctx.now());
}

/**
 * Moves the allowance rows that were following their person's default to the new one,
 * after a change to the rules or to where people sit (department, level): each row of
 * `userIds` for `fromYear` or later (closed years stay as they were settled) whose
 * `days` equal its default `before` the change takes its default `after`, when that
 * differs and is not "no default". Rows set to anything else were set by hand and stay.
 *
 * Each move writes `allowance.rule_applied` and `balance.adjusted` (`reason:
 * "allowance_rule"`), attributed to `actor`. The rows are locked first, so a submit in
 * flight either sees the new allowance or finishes first.
 *
 * @returns How many rows moved.
 */
export async function followDefaults(
  tx: Transaction,
  actor: Actor,
  change: { userIds: readonly string[]; leaveTypeIds?: readonly string[]; fromYear: number; before: AllowanceDefaults; after: AllowanceDefaults },
): Promise<number> {
  const rows = await lockAllowancesFrom(tx, { userIds: change.userIds, fromYear: change.fromYear, leaveTypeIds: change.leaveTypeIds });
  if (rows.length === 0) return 0;
  const types = new Map((await listAllLeaveTypes(tx, actor.companyId)).map((t) => [t.id, t]));
  let moved = 0;
  for (const row of rows) {
    const type = types.get(row.leaveTypeId);
    if (!type) continue;
    const before = change.before(row.userId, type);
    const after = change.after(row.userId, type);
    if (before === null || after === null || before === after || row.days !== before) continue;
    const updated = await setAllowanceDays(tx, row.id, after);
    await recordAllowanceChange(tx, { companyId: actor.companyId, reason: "allowance_rule", before: row, after: updated, source: actor.source });
    moved++;
  }
  return moved;
}
