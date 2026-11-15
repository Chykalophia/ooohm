import "server-only";
/** What the balances module hands out: balances, assessments and admin results. Never a row. */
import type { DayPortion, LeaveRange } from "@/shared/kernel/leave-range";
import type { Balance, PeriodCharge } from "../domain/allowance-policy";
import type { Allowance } from "../domain/allowance";
import type { StoredAllowanceRule } from "./ports";

/** The date and type part of a leave request, before it is stored. */
export interface LeaveDraft {
  leaveTypeId: string;
  startDate: string;
  /** Defaults to `startDate` when empty. */
  endDate?: string | null | undefined;
  dayPortion: DayPortion;
}

/** A leave request checked against the calendar, the actor's other requests and their balance. */
export interface LeaveAssessment {
  range: LeaveRange;
  leaveType: { id: string; name: string };
  /** Total working days (half day = 0.5); always > 0. */
  days: number;
  /** Per calendar year, in order: the days charged and the balance before this request. */
  charges: PeriodCharge[];
}

/** One leave type's balance, as the dashboard shows it. */
export interface BalanceSummaryItem {
  leaveTypeId: string;
  name: string;
  color: string;
  balance: Balance;
  /** The type is archived: no new requests, but its balance still shows where it has history. */
  archived: boolean;
  /** The person's own allowance row for the year, if they have one (admins edit it). */
  row: { days: number; carriedOverDays: number; adjustmentDays: number } | null;
}

export interface BalanceSummary {
  year: number;
  items: BalanceSummaryItem[];
}

/** One person's allowance of one leave type and year. */
export type AllowanceDTO = Allowance;

export interface AllowanceOverrideResult {
  row: AllowanceDTO;
  /**
   * False when the amounts already matched: nothing was written or recorded, and the
   * reason was dropped. The caller must say so rather than report a save.
   */
  changed: boolean;
}

/** An allowance rule. */
export type AllowanceRuleDTO = StoredAllowanceRule;

export interface AllowanceRuleResult extends AllowanceRuleDTO {
  /** People's allowance rows that were following the default and moved with the change. */
  allowancesUpdated: number;
}

/** A rule with the names of its department and level, as the rules card lists it. */
export interface NamedAllowanceRuleDTO extends AllowanceRuleDTO {
  departmentName: string | null;
  levelName: string | null;
}

/** What a leave type's rules card shows. */
export interface AllowanceRulesFormDTO {
  rules: NamedAllowanceRuleDTO[];
  /** The departments and levels a new rule can name. */
  departments: { id: string; name: string }[];
  levels: { id: string; name: string }[];
}
