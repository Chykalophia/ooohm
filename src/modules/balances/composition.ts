import "server-only";
/**
 * Balances' composition root: binds the use cases to their concrete ports. Everything
 * outside the module calls the functions here (through `index.ts`) with a
 * `ServiceContext` or the caller's executor; the use cases themselves take
 * {@link BalancesDeps}, so tests run them on in-memory fakes.
 */
import type { Executor, Transaction } from "@/db/types";
import type { Actor } from "@/shared/kernel/actor";
import type { ServiceContext } from "@/server/context";
import { inTransaction } from "@/shared/lib/unit-of-work";
import type { AllowanceChange } from "./application/allowance-changes";
import type { LeaveDraft } from "./application/dto";
import { followDefaults as follow } from "./application/follow-defaults";
import { type Recarry, recarryMemberLeaveType as recarry } from "./application/member-rollover";
import type { BalancesDeps, BalancesStore } from "./application/ports";
import { assessLeaveRequest as assess } from "./application/queries/assess-leave-request";
import { getAllowanceRulesForm as rulesForm } from "./application/queries/get-allowance-rules-form";
import { getBalanceSummary as balanceSummary } from "./application/queries/get-balance-summary";
import { listAllowanceRulesForAdmin as rulesForAdmin } from "./application/queries/list-allowance-rules-for-admin";
import { loadAllowanceDefaults as defaultsIn } from "./application/queries/load-allowance-defaults";
import { loadBalanceInputs as inputsIn, loadBalances as balancesIn } from "./application/queries/load-balances";
import { previewLeaveRequest as preview } from "./application/queries/preview-leave-request";
import { summarizeBalances as summarize } from "./application/queries/summarize-balances";
import { removeAllowanceRule as removeRule } from "./application/use-cases/remove-allowance-rule";
import { runYearRollover as rollover } from "./application/use-cases/roll-over-year";
import { type AllowanceOverrideInput, setAllowanceOverride as setOverride } from "./application/use-cases/set-allowance-override";
import { type AllowanceRuleInput, setAllowanceRule as setRule } from "./application/use-cases/set-allowance-rule";
import { type AllowanceWrite, writeAllowance as write } from "./application/write-allowance";
import type { BalanceScope } from "./domain/allowance";
import type { AllowanceDefaults } from "./domain/allowance-rules";
import { drizzleAllowanceRuleRepository } from "./infrastructure/drizzle-allowance-rule.repository";
import { drizzleAllowanceRepository } from "./infrastructure/drizzle-allowance.repository";
import { drizzleBalancesDirectory } from "./infrastructure/drizzle-balances-directory";
import { drizzleChangeLog } from "./infrastructure/drizzle-change-log";

/** Every port on Drizzle, bound to `ex` (the pool, or one transaction). */
export function balancesStore(ex: Executor): BalancesStore {
  return {
    allowances: drizzleAllowanceRepository(ex),
    rules: drizzleAllowanceRuleRepository(ex),
    directory: drizzleBalancesDirectory(ex),
    changes: drizzleChangeLog(ex as Transaction),
  };
}

/** The use cases' dependencies for one service call. */
export function balancesDeps(ctx: ServiceContext): BalancesDeps {
  return {
    clock: { now: () => ctx.now() },
    read: balancesStore(ctx.db),
    unitOfWork: (work) => inTransaction(ctx, (tx) => work(balancesStore(tx))),
  };
}

// Use cases and queries, each `(ctx, …)` → ServiceResult.
export const getBalanceSummary = (ctx: ServiceContext, actor: Actor, year?: number) => balanceSummary(balancesDeps(ctx), actor, year);
export const previewLeaveRequest = (ctx: ServiceContext, actor: Actor, draft: LeaveDraft) => preview(balancesDeps(ctx), actor, draft);
export const setAllowanceOverride = (ctx: ServiceContext, actor: Actor, input: AllowanceOverrideInput) => setOverride(balancesDeps(ctx), actor, input);
export const setAllowanceRule = (ctx: ServiceContext, actor: Actor, input: AllowanceRuleInput) => setRule(balancesDeps(ctx), actor, input);
export const removeAllowanceRule = (ctx: ServiceContext, actor: Actor, id: string) => removeRule(balancesDeps(ctx), actor, id);
export const getAllowanceRulesForm = (ctx: ServiceContext, actor: Actor, leaveTypeId: string) => rulesForm(balancesDeps(ctx), actor, leaveTypeId);
export const listAllowanceRulesForAdmin = (ctx: ServiceContext, actor: Actor, leaveTypeId: string) => rulesForAdmin(balancesDeps(ctx), actor, leaveTypeId);
export const runYearRollover = (ctx: ServiceContext, fromYear?: number) => rollover(balancesDeps(ctx), fromYear);

// Reads and steps for other code's transactions, on the caller's executor; plain values, a `DomainError` throws.

/** The company's allowance defaults for `userIds`, read in `ex`: the only way a balance reads a default allowance. */
export function loadAllowanceDefaults(ex: Executor, companyId: string, userIds: readonly string[]): Promise<AllowanceDefaults> {
  return defaultsIn(drizzleAllowanceRuleRepository(ex), companyId, userIds);
}

/** The balance inputs (allowances, booked days and defaults) of these people, types and years, read in `ex`. */
export function loadBalanceInputs(ex: Executor, companyId: string, scope: BalanceScope) {
  return inputsIn(balancesStore(ex), companyId, scope);
}

export const loadBalances = (ex: Executor, scope: Parameters<typeof balancesIn>[1]) => balancesIn(balancesStore(ex), scope);
export const summarizeBalances = (ex: Executor, person: Parameters<typeof summarize>[1], loaded: Parameters<typeof summarize>[2]) =>
  summarize(balancesStore(ex), person, loaded);
export const assessLeaveRequest = (ex: Executor, actor: Pick<Actor, "id" | "companyId">, draft: LeaveDraft) => assess(balancesStore(ex), actor, draft);

/** A person's allowance of one leave type and year, read in `ex`. */
export const findAllowance = (ex: Executor, where: { userId: string; leaveTypeId: string; year: number }) => drizzleAllowanceRepository(ex).find(where);

/**
 * Allowance rows and booked-day sums in scope, read in `ex`, for the REST API's balance
 * list, which builds its balances with `balanceInputs`. New code reads
 * {@link loadBalanceInputs}.
 */
export const listAllowances = (ex: Executor, scope: BalanceScope) => drizzleAllowanceRepository(ex).list(scope);
export const sumBookedDays = (ex: Executor, scope: BalanceScope) => drizzleAllowanceRepository(ex).sumBooked(scope);

/** Re-carries a closed year for one person and type inside `tx`; `record` (if given) is called with `tx`. */
export function recarryMemberLeaveType(
  tx: Transaction,
  job: Omit<Recarry, "record"> & { record?: (tx: Transaction, change: AllowanceChange) => Promise<void> },
) {
  const { record, ...rest } = job;
  return recarry(balancesStore(tx), { ...rest, record: record && ((change) => record(tx, change)) });
}

/** One allowance write (the inbound sync's), inside `tx`, holding the member lock. */
export const writeAllowance = (tx: Transaction, job: AllowanceWrite) => write(balancesStore(tx), job);

/** Moves rows that followed their default after a move between departments or levels, inside `tx`. */
export const followDefaults = (tx: Transaction, actor: Actor, change: Parameters<typeof follow>[2]) => follow(balancesStore(tx), actor, change);
