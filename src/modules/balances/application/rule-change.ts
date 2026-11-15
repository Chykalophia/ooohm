import "server-only";
/**
 * What setting and removing an allowance rule share. The year rollover gives everyone
 * a row for the current year, so a rule that only changed the default would reach
 * nobody until next year. So a change also moves the rows that were following the
 * default: this year's and later rows whose `days` equal what the rules gave that
 * person before the change take what they give now ({@link followDefaults}). A row an
 * admin set to something else stays as it is.
 */
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { yearInTimeZone } from "@/lib/dates";
import type { Placement } from "../domain/allowance-rules";
import { followDefaults } from "./follow-defaults";
import type { BalancesStore, Clock } from "./ports";
import { loadAllowanceDefaults } from "./queries/load-allowance-defaults";

/** Locks the company and checks the actor, then this year in the company's time zone. */
export async function thisYear(store: BalancesStore, clock: Clock, actor: Actor): Promise<number> {
  const company = await store.directory.lockCompany(actor.companyId);
  if (!company) throw new DomainError("no_company");
  await store.directory.assertActiveAdmin(actor);
  return yearInTimeZone(company.timezone, clock.now());
}

/**
 * The people a rule's target matches, under their member locks: the year rollover reads
 * a member's defaults under that lock, so it either sees this change or finishes first
 * (and its new row is then moved here like any other).
 */
export async function membersAt(store: BalancesStore, actor: Actor, target: Placement): Promise<string[]> {
  const userIds = await store.rules.membersAt(actor.companyId, target);
  await store.directory.lockMembers(actor.companyId, userIds);
  return userIds;
}

/**
 * Runs `change` (the rule write and its record) between reading the matching people's
 * defaults before and after it, then moves their rows that were following the old
 * default of `leaveTypeId` from `fromYear` on.
 *
 * @returns What `change` returned, and how many rows moved.
 */
export async function withDefaultsFollowing<T>(
  store: BalancesStore,
  actor: Actor,
  scope: { target: Placement; leaveTypeId: string; fromYear: number },
  change: () => Promise<T>,
): Promise<{ result: T; allowancesUpdated: number }> {
  const userIds = await membersAt(store, actor, scope.target);
  const before = await loadAllowanceDefaults(store.rules, actor.companyId, userIds);
  const result = await change();
  const allowancesUpdated = await followDefaults(store, actor, {
    userIds,
    leaveTypeIds: [scope.leaveTypeId],
    fromYear: scope.fromYear,
    before,
    after: await loadAllowanceDefaults(store.rules, actor.companyId, userIds),
  });
  return { result, allowancesUpdated };
}
