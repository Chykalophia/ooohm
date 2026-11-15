import "server-only";
/**
 * The year rollover's step for one person, in the unit of work the caller opened: the
 * nightly run (`runYearRollover`), or a re-carry after an edit to a closed year.
 */
import type { ChangeSource } from "@/domain/change-source";
import { yearInTimeZone } from "@/lib/dates";
import type { AllowancePolicy } from "../domain/allowance-policy";
import type { AllowanceDefaults } from "../domain/allowance-rules";
import { balanceInputs } from "../domain/allowance";
import { type RolloverLeaveType, type RolloverScope, type RolloverStep, rolloverScope, rolloverStep } from "../domain/rollover";
import { type AllowanceChange, recordAllowanceChange } from "./allowance-changes";
import type { BalancesStore } from "./ports";
import { loadAllowanceDefaults } from "./queries/load-allowance-defaults";

/** What one person's rollover changed. */
export interface RollCounts {
  /** Allowance rows whose carried-over days were set (created or updated). */
  carried: number;
  /** Allowance rows created without carrying anything. */
  created: number;
}

const NOTHING: RollCounts = { carried: 0, created: 0 };

/** Records one allowance row the rollover created or changed; {@link recordAllowanceChange} by default. */
export type AllowanceChangeRecorder = (change: AllowanceChange) => Promise<void>;

export interface MemberRollover {
  companyId: string;
  timezone: string;
  policy: AllowancePolicy;
  memberId: string;
  memberCreatedAt: Date;
  /** Active types that count against allowance. */
  types: readonly RolloverLeaveType[];
  /** Whether to create current-year rows from defaults (the nightly run does; a re-carry does not). */
  createDefaults: boolean;
  closingYear: number;
  currentYear: number;
  /** Recorded on every row it writes: the rollover itself, or the edit that re-carried. */
  source: ChangeSource;
  /** Overrides how each change is recorded (the import audits without outbox events). */
  record?: AllowanceChangeRecorder;
}

/**
 * Rolls one person over, under their member lock (the same lock submit takes), so a
 * request submitted meanwhile is either fully counted or not at all.
 */
export async function rollMember(store: BalancesStore, job: MemberRollover): Promise<RollCounts> {
  const member = await store.directory.lockMember(job.companyId, job.memberId);
  if (!member?.isActive) return NOTHING;
  // The member's own defaults (allowance rules for their department and level), read
  // under their lock so a move between departments is either fully seen or not at all.
  const defaults = await loadAllowanceDefaults(store.rules, job.companyId, [member.id]);
  const own = job.types.map((t) => ({ ...t, defaultAllowanceDays: defaults(member.id, t) }));
  const scope = rolloverScope(own, {
    createDefaults: job.createDefaults,
    joinedYear: yearInTimeZone(job.timezone, job.memberCreatedAt),
    closingYear: job.closingYear,
  });
  const forward = await carryForward(store, job, scope, defaults);
  const created = await createCurrentYearRows(store, job, scope.defaultTypes);
  return { carried: forward.carried, created: forward.created + created };
}

/** Sets or creates each type's next-year row (carry, or a copy of the latest row for a type without a default). */
async function carryForward(store: BalancesStore, job: MemberRollover, scope: RolloverScope<RolloverLeaveType>, defaults: AllowanceDefaults): Promise<RollCounts> {
  if (scope.types.length === 0) return NOTHING;
  const userId = job.memberId;
  const nextYear = job.closingYear + 1;
  const carryIds = new Set(scope.carryTypes.map((t) => t.id));
  const allowanceRows = await store.allowances.list({ userIds: [userId], years: [job.closingYear, nextYear], leaveTypeIds: scope.types.map((t) => t.id) });
  const bookedRows = await store.allowances.sumBooked({ userIds: [userId], years: [job.closingYear], leaveTypeIds: [...carryIds] });
  const inputs = balanceInputs(allowanceRows, bookedRows, defaults);

  const counts = { ...NOTHING };
  for (const leaveType of scope.types) {
    const carry = carryIds.has(leaveType.id) ? job.policy.carryover(leaveType, inputs.balance(job.policy, leaveType, userId, job.closingYear)) : null;
    const step = rolloverStep({
      userId,
      leaveType,
      nextYear,
      carry,
      existing: inputs.allowanceRow(userId, leaveType.id, nextYear),
      latestDays: inputs.latestRow(userId, leaveType.id, job.closingYear)?.days,
    });
    const outcome = await applyStep(store, job, step);
    if (outcome) counts[outcome]++;
  }
  return counts;
}

/** Writes and records one {@link RolloverStep}; says which count it adds to, if any. */
async function applyStep(store: BalancesStore, job: MemberRollover, step: RolloverStep): Promise<keyof RollCounts | null> {
  const record = recorderFor(store, job);
  if (step.kind === "keep") return null;
  if (step.kind === "carry") {
    const after = await store.allowances.setCarriedOverDays(step.allowance.id, step.carriedOverDays);
    await record({ companyId: job.companyId, reason: "carryover", before: step.allowance, after, source: job.source });
    return "carried";
  }
  const [after] = await store.allowances.insertMissing([step.allowance]);
  if (!after) return null;
  await record({ companyId: job.companyId, reason: step.reason, before: null, after, source: job.source });
  return step.reason === "carryover" ? "carried" : "created";
}

/** A current-year row from each type's default, where the person has none; returns how many it created. */
async function createCurrentYearRows(store: BalancesStore, job: MemberRollover, types: RolloverScope<RolloverLeaveType>["defaultTypes"]): Promise<number> {
  const record = recorderFor(store, job);
  const created = await store.allowances.insertMissing(
    types.map((t) => ({ userId: job.memberId, leaveTypeId: t.id, year: job.currentYear, days: t.defaultAllowanceDays })),
  );
  for (const after of created) {
    await record({ companyId: job.companyId, reason: "allowance_created", before: null, after, source: job.source });
  }
  return created.length;
}

function recorderFor(store: BalancesStore, job: MemberRollover): AllowanceChangeRecorder {
  return job.record ?? ((change) => recordAllowanceChange(store.changes, change));
}

/** The re-carry of one person and leave type that an edit to a closed year asks for. */
export interface Recarry {
  companyId: string;
  timezone: string;
  policy: AllowancePolicy;
  member: { id: string; createdAt: Date };
  leaveType: RolloverLeaveType & { archivedAt: Date | null };
  closingYear: number;
  source: ChangeSource;
  /** Overrides how each change is recorded (the import audits without outbox events). */
  record?: AllowanceChangeRecorder;
}

/**
 * Re-runs the year rollover's per-member step for one person and one leave type, in
 * the caller's unit of work: recomputes the carry out of `closingYear` into the next
 * year (and, for a type without a default, copies the row forward), exactly as the
 * nightly run would, writing the same audit and outbox rows (unless `record` says
 * otherwise). Creates no current-year default rows; the nightly run still owns those.
 *
 * For an admin's (or a sync's) edit of a closed year's allowance, so the next year's
 * `carried_over_days` is right at once rather than after the next nightly run. The
 * caller must hold the member lock. Archived types and inactive members are skipped,
 * as the rollover skips them.
 *
 * @param job.source The edit's own source: the rows it writes are that edit's doing,
 *   not the nightly process's.
 * @returns How many rows changed.
 */
export async function recarryMemberLeaveType(store: BalancesStore, job: Recarry): Promise<RollCounts> {
  const t = job.leaveType;
  if (t.archivedAt !== null || !t.countsAgainstAllowance) return NOTHING;
  return rollMember(store, {
    companyId: job.companyId,
    timezone: job.timezone,
    policy: job.policy,
    memberId: job.member.id,
    memberCreatedAt: job.member.createdAt,
    types: [t],
    createDefaults: false,
    closingYear: job.closingYear,
    currentYear: job.closingYear + 1,
    source: job.source,
    record: job.record,
  });
}
