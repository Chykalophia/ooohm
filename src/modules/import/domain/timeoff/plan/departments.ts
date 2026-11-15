/**
 * Planning step: departments, one per name (ignoring case).
 */
import { normalizeDepartmentName } from "@/shared/kernel/names";
import type { TimeOffDepartment, TimeOffSnapshot } from "../source";
import type { PlannedDepartment, Warn } from "./types";

export interface DepartmentPlan {
  departments: PlannedDepartment[];
  /** TimeOff department id → the key of the planned department it becomes. */
  departmentKey: Map<number, number>;
  departmentById: Map<number, TimeOffDepartment>;
  /** The company's TimeOff departments, by id. */
  sourceDepartments: TimeOffDepartment[];
}

function departmentName(d: TimeOffDepartment): string {
  try {
    return normalizeDepartmentName(d.name);
  } catch {
    return `Department ${d.id}`;
  }
}

/** What OOOhm does not carry over from a department, as warnings. */
function warnDepartmentSettings(d: TimeOffDepartment, name: string, warn: Warn): void {
  if (!d.includePublicHolidays) {
    warn({ code: "department_hides_holidays", message: `"${name}" hides bank holidays on TimeOff's calendar; OOOhm shows company holidays to everyone.`, timeoffId: d.id });
  }
  if (d.isAccruedAllowance) {
    warn({
      code: "accrued_allowance",
      message: `"${name}" uses accrued allowance in TimeOff (only days earned so far are available). OOOhm grants the full year; balances are compared on the full-year figure.`,
      timeoffId: d.id,
    });
  }
}

/** The company's departments; two with the same name become one (the first). */
export function planDepartments(snapshot: TimeOffSnapshot, companyId: number, warn: Warn): DepartmentPlan {
  const departments: PlannedDepartment[] = [];
  const departmentKey = new Map<number, number>();
  const byName = new Map<string, number>();
  const sourceDepartments = snapshot.departments.filter((d) => d.companyId === companyId).sort((a, b) => a.id - b.id);
  for (const d of sourceDepartments) {
    const name = departmentName(d);
    const existing = byName.get(name.toLowerCase());
    if (existing !== undefined) {
      departmentKey.set(d.id, existing);
      warn({ code: "department_duplicate", message: `Departments ${existing} and ${d.id} are both named "${name}"; they become one.`, timeoffId: d.id });
    } else {
      byName.set(name.toLowerCase(), d.id);
      departmentKey.set(d.id, d.id);
      departments.push({ key: d.id, name });
    }
    warnDepartmentSettings(d, name, warn);
  }
  if (snapshot.departmentSupervisorLinks > 0) {
    warn({
      code: "department_supervisors",
      message: `${snapshot.departmentSupervisorLinks} extra department supervisor link(s) were not imported: OOOhm has one approver per person (their manager, else an admin).`,
    });
  }
  return { departments, departmentKey, departmentById: new Map(sourceDepartments.map((d) => [d.id, d])), sourceDepartments };
}
