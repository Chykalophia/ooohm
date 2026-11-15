import "server-only";
/**
 * The balances module's public API (see README.md). Everything outside the module
 * imports from here only. Use cases and queries that take a `ServiceContext` return a
 * `ServiceResult`; the executor-taking reads and steps run inside another module's or
 * service's transaction and return plain values.
 *
 * A balance reads a person's default allowance only through `loadAllowanceDefaults`
 * (and the reads built on it); the rule arithmetic itself is not exported.
 */
export {
  getBalanceSummary,
  previewLeaveRequest,
  setAllowanceOverride,
  setAllowanceRule,
  removeAllowanceRule,
  getAllowanceRulesForm,
  listAllowanceRulesForAdmin,
  runYearRollover,
  loadAllowanceDefaults,
  loadBalanceInputs,
  loadBalances,
  summarizeBalances,
  assessLeaveRequest,
  findAllowance,
  listAllowances,
  sumBookedDays,
  recarryMemberLeaveType,
  writeAllowance,
  followDefaults,
} from "./composition";
export { draftRange } from "./application/queries/assess-leave-request";
export type { BalanceLookup } from "./application/queries/load-balances";
export type { RolloverResult } from "./application/use-cases/roll-over-year";
export type { AllowanceOverrideInput } from "./application/use-cases/set-allowance-override";
export type { AllowanceRuleInput } from "./application/use-cases/set-allowance-rule";
export type { AllowanceChange } from "./application/allowance-changes";
export type { AllowanceChangeRecorder, RollCounts } from "./application/member-rollover";
export type { LeaveTypeWithAllowance } from "./application/ports";
export { canEditAllowances, canManageAllowanceRules } from "./application/policies";
export type {
  AllowanceDTO,
  AllowanceOverrideResult,
  AllowanceRuleDTO,
  AllowanceRuleResult,
  AllowanceRulesFormDTO,
  BalanceSummary,
  BalanceSummaryItem,
  LeaveAssessment,
  LeaveDraft,
  NamedAllowanceRuleDTO,
} from "./application/dto";

// The allowance policy (a Strategy, resolved by key) and the balance arithmetic.
export type {
  AllowancePolicy,
  AllowanceRecord,
  Balance,
  BalanceInput,
  BookedDays,
  LeaveTypeAllowanceSettings,
  PeriodCharge,
  RequestCost,
} from "./domain/allowance-policy";
export { assertCovered, findShortfall, isEmptyBalance, remainingAfter } from "./domain/allowance-policy";
export { resolveAllowancePolicy } from "./domain/policy-registry";
export { ALLOWANCE_POLICY_KEYS, ANNUAL_CALENDAR_YEAR } from "@/shared/kernel/allowance-policy-keys";
export { allowanceYearsFor, balanceInputs, type BalanceInputs, type BalanceScope } from "./domain/allowance";
export type { AllowanceDefaults, Placement } from "./domain/allowance-rules";
export { addDays } from "@/shared/kernel/day-amounts";
