import type { Transaction } from "@/db/types";
import { type AllowancePolicy, type LeaveTypeAllowanceSettings, resolveAllowancePolicy } from "@/domain/allowance-policy";
import { bySystem, CHANGE_PROCESSES, type ChangeSource } from "@/domain/change-source";
import { DomainError } from "@/domain/errors";
import { yearInTimeZone } from "@/lib/dates";
import { log } from "@/lib/log";
import type { ServiceContext } from "@/server/context";
import { insertMissingAllowances, listAllowances, setCarriedOverDays, sumBookedDays } from "@/server/repositories/balances";
import { listCompanies } from "@/server/repositories/calendar";
import { listActiveLeaveTypesWithAllowance } from "@/server/repositories/leave-types";
import { listActiveMembers, lockMember } from "@/server/repositories/users";
import { recordAllowanceChange } from "./allowance-changes";
import { balanceInputs } from "./balances";
import { inTransaction } from "./notify";

/** What one run changed. A second run over the same data reports zeros. */
export interface RolloverResult {
  companies: number;
  /** Active members processed. */
  members: number;
  /** Allowance rows whose carried-over days were set (created or updated). */
  carried: number;
  /**
   * Allowance rows created without carrying anything: current-year rows from leave
   * type defaults, and next-year rows copied from a person's latest row for a type
   * without a default.
   */
  created: number;
}

type LeaveTypeForRollover = LeaveTypeAllowanceSettings & { id: string };

/** Records one allowance row the rollover created or changed; {@link recordAllowanceChange} by default. */
export type AllowanceChangeRecorder = (tx: Transaction, change: Parameters<typeof recordAllowanceChange>[1]) => Promise<void>;

interface MemberRollover {
  companyId: string;
  timezone: string;
  policy: AllowancePolicy;
  memberId: string;
  memberCreatedAt: Date;
  /** Counting types with `carryover_enabled`. */
  carryTypes: readonly LeaveTypeForRollover[];
  /** Counting types without a default allowance, carryover on or off. */
  noDefaultTypes: readonly LeaveTypeForRollover[];
  defaultTypes: readonly (LeaveTypeForRollover & { defaultAllowanceDays: number })[];
  closingYear: number;
  currentYear: number;
  /** Recorded on every row it writes: the rollover itself, or the edit that re-carried. */
  source: ChangeSource;
  record: AllowanceChangeRecorder;
}

/** The nightly (or `pnpm job:rollover`) run has no person behind it. */
const ROLLOVER_SOURCE = bySystem(CHANGE_PROCESSES.yearRollover);

/**
 * Rolls one person over, in one transaction under their member lock (the same lock
 * submit takes), so a request submitted meanwhile is either fully counted or not at all.
 */
async function rollMember(tx: Transaction, job: MemberRollover): Promise<{ carried: number; created: number }> {
  const member = await lockMember(tx, job.companyId, job.memberId);
  if (!member?.isActive) return { carried: 0, created: 0 };
  const nextYear = job.closingYear + 1;
  let carried = 0;
  let created = 0;

  // Someone who joined after the closing year had no balance in it, so carries nothing.
  const carryTypes = yearInTimeZone(job.timezone, job.memberCreatedAt) <= job.closingYear ? job.carryTypes : [];
  const carryIds = new Set(carryTypes.map((t) => t.id));
  const types = [...carryTypes, ...job.noDefaultTypes.filter((t) => !carryIds.has(t.id))];
  if (types.length > 0) {
    const allowanceRows = await listAllowances(tx, {
      userIds: [member.id],
      years: [job.closingYear, nextYear],
      leaveTypeIds: types.map((t) => t.id),
    });
    const bookedRows = await sumBookedDays(tx, { userIds: [member.id], years: [job.closingYear], leaveTypeIds: [...carryIds] });
    const inputs = balanceInputs(allowanceRows, bookedRows);

    for (const leaveType of types) {
      const carry = carryIds.has(leaveType.id)
        ? job.policy.carryover(leaveType, inputs.balance(job.policy, leaveType, member.id, job.closingYear))
        : null;
      const existing = inputs.allowanceRow(member.id, leaveType.id, nextYear);
      if (existing) {
        if (carry === null || existing.carriedOverDays === carry) continue;
        const after = await setCarriedOverDays(tx, existing.id, carry);
        await job.record(tx, { companyId: job.companyId, reason: "carryover", before: existing, after, source: job.source });
        carried++;
        continue;
      }
      // With a default and nothing to carry, the default already covers next year
      // (the current-year step below creates that row when next year is current).
      if (!carry && leaveType.defaultAllowanceDays !== null) continue;
      // Without a default, the person's latest row is copied forward, carry or not, so
      // next year has a row of its own (the balance would inherit it anyway) that an
      // admin can see and edit. Nobody who never had a row gets one.
      const days = leaveType.defaultAllowanceDays ?? inputs.latestRow(member.id, leaveType.id, job.closingYear)?.days;
      if (days === undefined) continue;
      const [after] = await insertMissingAllowances(tx, [
        { userId: member.id, leaveTypeId: leaveType.id, year: nextYear, days, carriedOverDays: carry ?? 0 },
      ]);
      if (!after) continue;
      const reason = carry ? "carryover" : "allowance_created";
      await job.record(tx, { companyId: job.companyId, reason, before: null, after, source: job.source });
      if (reason === "carryover") carried++;
      else created++;
    }
  }

  const createdRows = await insertMissingAllowances(
    tx,
    job.defaultTypes.map((t) => ({ userId: member.id, leaveTypeId: t.id, year: job.currentYear, days: t.defaultAllowanceDays })),
  );
  for (const after of createdRows) {
    await job.record(tx, { companyId: job.companyId, reason: "allowance_created", before: null, after, source: job.source });
  }
  return { carried, created: created + createdRows.length };
}

/**
 * Re-runs the year rollover's per-member step for one person and one leave type, inside
 * the caller's transaction: recomputes the carry out of `closingYear` into the next
 * year (and, for a type without a default, copies the row forward), exactly as
 * {@link runYearRollover} would, writing the same audit and outbox rows (unless `record` says otherwise). Creates no
 * current-year default rows; the nightly run still owns those.
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
export async function recarryMemberLeaveType(
  tx: Transaction,
  job: {
    companyId: string;
    timezone: string;
    policy: AllowancePolicy;
    member: { id: string; createdAt: Date };
    leaveType: LeaveTypeForRollover & { archivedAt: Date | null };
    closingYear: number;
    source: ChangeSource;
    /** Overrides how each change is recorded (the import audits without outbox events). */
    record?: AllowanceChangeRecorder;
  },
): Promise<{ carried: number; created: number }> {
  const t = job.leaveType;
  if (t.archivedAt !== null || !t.countsAgainstAllowance) return { carried: 0, created: 0 };
  return rollMember(tx, {
    companyId: job.companyId,
    timezone: job.timezone,
    policy: job.policy,
    memberId: job.member.id,
    memberCreatedAt: job.member.createdAt,
    carryTypes: t.carryoverEnabled ? [t] : [],
    noDefaultTypes: t.defaultAllowanceDays === null ? [t] : [],
    defaultTypes: [],
    closingYear: job.closingYear,
    currentYear: job.closingYear + 1,
    source: job.source,
    record: job.record ?? recordAllowanceChange,
  });
}

/**
 * Closes a calendar year: carries leave over into the next year and makes sure every
 * active member has an allowance row for the current year. Idempotent: it sets values
 * rather than adding to them, so running it again over the same data changes nothing
 * and writes nothing.
 *
 * For every company, every active member and every active leave type that counts
 * against allowance with `carryover_enabled`, next year's `carried_over_days` becomes
 * the policy's carryover of the closing year's remaining before any carry (v1:
 * clamped to `[0, carryover_max_days]`). A missing next-year row is created from the
 * type's default allowance. Members created after the closing year carry nothing.
 * For every counting type without a default, carryover on or off, a person with a row
 * in or before the closing year gets a missing next-year row copied from their latest
 * one (`days`), even when nothing carries; the balance already inherits that row, so
 * this only makes it explicit. Then each member gets a current-year row, from the
 * default, for every tracked type that has a default; existing rows are never
 * overwritten.
 *
 * Each member is processed in its own transaction under their member lock, and every
 * row created or changed writes an `audit_log` row (`allowance.carried_over` or
 * `allowance.created`, source `system` / `year_rollover`) and a `balance.adjusted` event in that
 * transaction. Carryover stays off unless a leave type turns it on.
 *
 * Re-running after a closing-year request is cancelled, rejected or added recomputes
 * the carryover from the new remaining, and records the change. So this job owns
 * `carried_over_days`: a hand edit there is overwritten by the next run, and balance
 * corrections belong in `adjustment_days`, which it never touches.
 *
 * @param fromYear The year to close. Defaults to the year before the current one in
 *   each company's time zone.
 * @throws DomainError `policy_unavailable` (before any change) when a company's policy
 *   is unknown, or `invalid_input` when `fromYear` has not ended yet for a company.
 */
export async function runYearRollover(ctx: ServiceContext, fromYear?: number): Promise<RolloverResult> {
  const companies = await listCompanies(ctx.db);
  const plans = companies.map((company) => {
    const policy = resolveAllowancePolicy(company.allowancePolicy);
    const currentYear = yearInTimeZone(company.timezone, ctx.now());
    const closingYear = fromYear ?? currentYear - 1;
    if (!Number.isInteger(closingYear) || closingYear >= currentYear) {
      throw new DomainError("invalid_input", `Year ${closingYear} has not ended yet (it is ${currentYear} in ${company.timezone}).`);
    }
    return { company, policy, currentYear, closingYear };
  });

  const result: RolloverResult = { companies: plans.length, members: 0, carried: 0, created: 0 };
  for (const { company, policy, currentYear, closingYear } of plans) {
    const [types, members] = await Promise.all([
      listActiveLeaveTypesWithAllowance(ctx.db, company.id),
      listActiveMembers(ctx.db, company.id),
    ]);
    const carryTypes = types.filter((t) => t.carryoverEnabled && t.countsAgainstAllowance);
    const noDefaultTypes = types.filter((t) => t.countsAgainstAllowance && t.defaultAllowanceDays === null);
    const defaultTypes = types.flatMap((t) =>
      t.countsAgainstAllowance && t.defaultAllowanceDays !== null ? [{ ...t, defaultAllowanceDays: t.defaultAllowanceDays }] : [],
    );

    let carried = 0;
    let created = 0;
    for (const member of members) {
      const changes = await inTransaction(ctx, (tx) =>
        rollMember(tx, {
          companyId: company.id,
          timezone: company.timezone,
          policy,
          memberId: member.id,
          memberCreatedAt: member.createdAt,
          carryTypes,
          noDefaultTypes,
          defaultTypes,
          closingYear,
          currentYear,
          source: ROLLOVER_SOURCE,
          record: recordAllowanceChange,
        }),
      );
      carried += changes.carried;
      created += changes.created;
    }
    log.info({ companyId: company.id, closingYear, members: members.length, carried, created }, "year_rollover_company");
    result.members += members.length;
    result.carried += carried;
    result.created += created;
  }
  return result;
}
