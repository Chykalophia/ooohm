/**
 * Planning step: leave types, with TimeOff's allowance pool mapped onto one of them (the
 * pool type; see the planner's comment in `../mapping.ts`).
 */
import { MAX_ALLOWANCE_DAYS, normalizeLeaveTypeColor } from "@/shared/kernel/leave-type-settings";
import type { TimeOffDepartment, TimeOffLeaveType } from "../source";
import { FALLBACK_COLORS, leaveTypeCodeFor, refuse, typeName } from "./rules";
import type { ImportPlanOptions, PlannedCompany, PlannedLeaveType, Warn } from "./types";

export interface LeaveTypePlan {
  leaveTypes: PlannedLeaveType[];
  /** TimeOff type id → the OOOhm code it maps onto. */
  typeKeyOf: Map<number, string>;
  /** The TimeOff types that use the allowance pool. */
  poolIds: Set<number>;
  /** The TimeOff type whose name the pool type takes; absent when no type uses the allowance. */
  poolSource: TimeOffLeaveType | undefined;
  poolKey: string | null;
  /** The pool type's default allowance; `null` when the departments differ. */
  poolDefault: number | null;
}

/**
 * The pool's source type: the one named by `poolTypeName`, else the first `use_allowance`
 * type by sort order.
 *
 * @throws DomainError `import_refused` for an unknown `poolTypeName`, or several pool
 *   types without `mergePoolTypes`.
 */
export function choosePoolSource(leaveTypes: readonly TimeOffLeaveType[], options: Pick<ImportPlanOptions, "poolTypeName" | "mergePoolTypes">) {
  const poolCandidates = leaveTypes.filter((t) => t.useAllowance);
  let poolSource: TimeOffLeaveType | undefined;
  if (options.poolTypeName !== undefined) {
    const wanted = options.poolTypeName.trim().toLowerCase();
    poolSource = poolCandidates.find((t) => t.name.trim().toLowerCase() === wanted);
    if (!poolSource) {
      refuse(
        `--pool-type "${options.poolTypeName}" is not a TimeOff leave type that uses the allowance. Those are: ${
          poolCandidates.map((t) => `"${t.name}"`).join(", ") || "none"
        }.`,
      );
    }
  } else {
    poolSource = poolCandidates[0];
  }
  if (poolCandidates.length > 1 && !options.mergePoolTypes) {
    refuse(
      `${poolCandidates.length} TimeOff leave types share the allowance pool: ${poolCandidates.map((t) => `"${t.name}"`).join(", ")}. ` +
        `OOOhm keeps an allowance per leave type, so one balance needs one type. Pass --merge-pool-types to import them all as ` +
        `"${poolSource!.name}" (each request keeps its original type name in its note), and --pool-type "<name>" to choose which name the merged type takes. ` +
        `Or, in TimeOff, turn "use allowance" off for the types that should not count, then export again.`,
    );
  }
  return { poolCandidates, poolSource };
}

/**
 * People invited after the import get the pool type's default allowance. TimeOff's
 * allowance is per department, so there is one figure to default to only when every
 * department has the same; imported people always get explicit rows either way.
 */
function poolDefaultOf(poolSource: TimeOffLeaveType | undefined, sourceDepartments: readonly TimeOffDepartment[], warn: Warn): number | null {
  const departmentAllowances = [...new Set(sourceDepartments.map((d) => d.allowance))].sort((a, b) => a - b);
  const [only] = departmentAllowances;
  const poolDefault = departmentAllowances.length === 1 && only !== undefined && only >= 0 && only <= MAX_ALLOWANCE_DAYS ? only : null;
  if (poolSource && poolDefault === null) {
    warn({
      code: "pool_type_no_default",
      message:
        `"${typeName(poolSource)}" gets no default allowance, because TimeOff's departments have different allowances ` +
        `(${departmentAllowances.join(", ") || "none"} days). Everyone imported has their own allowance, but anyone invited later ` +
        `would have unlimited, untracked "${typeName(poolSource)}" until an admin sets a default under Leave types or gives them an allowance.`,
    });
  }
  return poolDefault;
}

interface TypeContext {
  poolSource: TimeOffLeaveType | undefined;
  poolCandidates: readonly TimeOffLeaveType[];
  poolDefault: number | null;
  company: PlannedCompany;
}

/** The planned types and each TimeOff type's code. The pool type leads (the request form preselects the first type); the rest keep TimeOff's order. */
function plannedTypesOf(leaveTypes: readonly TimeOffLeaveType[], c: TypeContext, badColors: string[]) {
  const poolIds = new Set(c.poolCandidates.map((t) => t.id));
  const codes = new Set<string>();
  const planned: PlannedLeaveType[] = [];
  const typeKeyOf = new Map<number, string>();
  const colorFor = (t: TimeOffLeaveType, index: number) => {
    try {
      return normalizeLeaveTypeColor(t.color);
    } catch {
      badColors.push(t.name);
      // The index is taken modulo the list's length, so it is always in range.
      return FALLBACK_COLORS[index % FALLBACK_COLORS.length]!;
    }
  };
  const ordered = [...leaveTypes.entries()].sort(([, a], [, b]) => Number(b.id === c.poolSource?.id) - Number(a.id === c.poolSource?.id));
  for (const [index, t] of ordered) {
    if (poolIds.has(t.id) && t.id !== c.poolSource!.id) continue;
    const key = leaveTypeCodeFor(t.name, codes);
    codes.add(key);
    const pool = t.id === c.poolSource?.id;
    const settings = pool ? poolSettings(c) : otherSettings(t);
    const timeoffTypeIds = pool ? c.poolCandidates.map((p) => p.id) : [t.id];
    planned.push({ key, name: typeName(t), color: colorFor(t, index), ...settings, sortOrder: planned.length, pool, timeoffTypeIds });
    for (const id of timeoffTypeIds) typeKeyOf.set(id, key);
  }
  return { planned, typeKeyOf, poolIds };
}

/** The pool type: tracked, with the pool's default and the company's carryover. */
function poolSettings(c: TypeContext) {
  return { countsAgainstAllowance: true, defaultAllowanceDays: c.poolDefault, carryoverEnabled: c.company.carryoverEnabled, carryoverMaxDays: c.company.carryoverMaxDays };
}

/** A type outside the pool: untracked, or tracked with TimeOff's yearly `limit` as its default. */
function otherSettings(t: TimeOffLeaveType) {
  const limit = t.limit > 0 ? Math.min(t.limit, MAX_ALLOWANCE_DAYS) : null;
  return { countsAgainstAllowance: limit !== null, defaultAllowanceDays: limit, carryoverEnabled: false, carryoverMaxDays: null };
}

/** What OOOhm does not carry over from the leave types, as warnings. */
function warnTypeSettings(leaveTypes: readonly TimeOffLeaveType[], poolCandidates: readonly TimeOffLeaveType[], badColors: readonly string[], warn: Warn): void {
  for (const t of poolCandidates.filter((p) => p.limit > 0)) {
    warn({ code: "pool_type_limit", message: `"${t.name}" has a yearly limit of ${t.limit} in TimeOff on top of the shared allowance; OOOhm keeps only the allowance for it.`, timeoffId: t.id });
  }
  for (const t of leaveTypes.filter((lt) => lt.autoApprove)) {
    warn({ code: "type_auto_approve", message: `"${t.name}" is approved automatically in TimeOff; OOOhm approves automatically per person (self-approval), not per type.`, timeoffId: t.id });
  }
  if (badColors.length > 0) {
    warn({ code: "type_color", message: `Leave type colours that are not hex values got a default colour: ${badColors.map((n) => `"${n}"`).join(", ")}.` });
  }
}

/** The company's leave types, the pool type first. */
export function planLeaveTypes(
  leaveTypes: readonly TimeOffLeaveType[],
  sourceDepartments: readonly TimeOffDepartment[],
  company: PlannedCompany,
  options: Pick<ImportPlanOptions, "poolTypeName" | "mergePoolTypes">,
  warn: Warn,
): LeaveTypePlan {
  const { poolCandidates, poolSource } = choosePoolSource(leaveTypes, options);
  if (!poolSource) {
    warn({ code: "no_pool", message: "No TimeOff leave type uses the allowance: every type imports untracked and no allowance is imported." });
  }
  const poolDefault = poolDefaultOf(poolSource, sourceDepartments, warn);
  const badColors: string[] = [];
  const { planned, typeKeyOf, poolIds } = plannedTypesOf(leaveTypes, { poolSource, poolCandidates, poolDefault, company }, badColors);
  warnTypeSettings(leaveTypes, poolCandidates, badColors, warn);
  const poolKey = poolSource ? typeKeyOf.get(poolSource.id)! : null;
  return { leaveTypes: planned, typeKeyOf, poolIds, poolSource, poolKey, poolDefault };
}
