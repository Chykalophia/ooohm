/**
 * Planning step: people, one per email, with their role, department and manager.
 */
import type { CalendarDate } from "@/shared/kernel/calendar-date";
import { normalizeEmail, normalizePersonName, PERSON_NAME_MAX_LENGTH } from "@/shared/kernel/names";
import type { TimeOffDepartment, TimeOffUser } from "../source";
import { keepOne } from "./rules";
import type { CompanyScope, ImportIssue, KeptUser, PlannedPerson, Warn } from "./types";

export interface PeoplePlan {
  people: PlannedPerson[];
  /** The users kept, by TimeOff id. */
  kept: KeptUser[];
  keptIds: Set<number>;
  /** Every TimeOff user id with a usable email → the id kept for that email. */
  personOf: Map<number, number>;
  skippedUsers: number;
}

/**
 * TimeOff decides employment from `end_date` alone (still employed while it is in the
 * future). Its `activated` flag only records that the account has signed in once.
 */
export const timeOffEmployed = (today: CalendarDate) => (u: TimeOffUser) => u.endDate === null || u.endDate > today;

/** Users by normalized email; one OOOhm cannot use is a conflict. */
function groupByEmail(users: readonly TimeOffUser[], conflicts: ImportIssue[]): { groups: Map<string, TimeOffUser[]>; skipped: number } {
  const groups = new Map<string, TimeOffUser[]>();
  let skipped = 0;
  for (const u of users) {
    let email: string;
    try {
      email = normalizeEmail(u.email);
    } catch {
      conflicts.push({ code: "invalid_email", message: `TimeOff user ${u.id} has an email OOOhm cannot use ("${u.email}"); not imported.`, timeoffId: u.id });
      skipped++;
      continue;
    }
    groups.set(email, [...(groups.get(email) ?? []), u]);
  }
  return { groups, skipped };
}

/** One user per email (see `keepOne`); the others are conflicts. Sorted by TimeOff id. */
function keepPerEmail(
  groups: ReadonlyMap<string, TimeOffUser[]>,
  isActive: (u: TimeOffUser) => boolean,
  leaveCount: ReadonlyMap<number, number>,
  conflicts: ImportIssue[],
): { kept: KeptUser[]; personOf: Map<number, number>; skipped: number } {
  const personOf = new Map<number, number>();
  const kept: KeptUser[] = [];
  let skipped = 0;
  for (const [email, group] of groups) {
    const keep = keepOne(group, isActive, (id) => leaveCount.get(id) ?? 0);
    for (const u of group) personOf.set(u.id, keep.id);
    kept.push({ user: keep, email });
    for (const other of group.filter((u) => u.id !== keep.id)) {
      skipped++;
      conflicts.push({
        code: "duplicate_email",
        email,
        timeoffId: other.id,
        message: `TimeOff users ${keep.id} and ${other.id} share the email ${email} (ignoring case). Imported ${keep.id}; ${other.id} and its ${leaveCount.get(other.id) ?? 0} leave(s) were not imported.`,
      });
    }
  }
  kept.sort((a, b) => a.user.id - b.user.id);
  return { kept, personOf, skipped };
}

/** Each kept user's manager: their department's boss (never themself), as a kept id. */
export function managersOf(
  kept: readonly KeptUser[],
  departmentById: ReadonlyMap<number, TimeOffDepartment>,
  personOf: ReadonlyMap<number, number>,
  warn: Warn,
): Map<number, number | null> {
  const managerOf = new Map<number, number | null>();
  for (const { user: u, email } of kept) {
    const dept = u.departmentId !== null ? departmentById.get(u.departmentId) : undefined;
    const boss = dept?.bossId != null ? personOf.get(dept.bossId) : undefined;
    if (dept?.bossId != null && boss === undefined) {
      warn({ code: "boss_missing", email, message: `${email}'s department boss (TimeOff user ${dept.bossId}) was not imported; an admin approves their leave.` });
    }
    managerOf.set(u.id, boss !== undefined && boss !== u.id ? boss : null);
  }
  breakManagerLoops(kept, managerOf, warn);
  return managerOf;
}

/** A manager chain that loops back (A's boss is B, B's is A) would make approvals circular: the person it returns to gets no manager. */
function breakManagerLoops(kept: readonly KeptUser[], managerOf: Map<number, number | null>, warn: Warn): void {
  for (const { user: u, email } of kept) {
    const seen = new Set<number>([u.id]);
    for (let m = managerOf.get(u.id) ?? null; m !== null; m = managerOf.get(m) ?? null) {
      if (seen.has(m)) {
        if (m === u.id) {
          managerOf.set(u.id, null);
          warn({ code: "manager_cycle", email, message: `${email}'s managers form a loop through their departments; ${email} was left without a manager (an admin approves).` });
        }
        break;
      }
      seen.add(m);
    }
  }
}

interface PersonContext {
  today: CalendarDate;
  isActive: (u: TimeOffUser) => boolean;
  departmentKey: ReadonlyMap<number, number>;
  managerOf: ReadonlyMap<number, number | null>;
  managers: ReadonlySet<number>;
}

/** One kept user as an OOOhm person. */
export function toPlannedPerson({ user: u, email }: KeptUser, c: PersonContext, warn: Warn): PlannedPerson {
  let name: string;
  try {
    name = normalizePersonName(`${u.name} ${u.lastname}`);
  } catch {
    name = (email.split("@")[0] ?? "").slice(0, PERSON_NAME_MAX_LENGTH);
  }
  const isActive = c.isActive(u);
  if (!u.activated && isActive) {
    warn({ code: "never_signed_in", email, message: `${email} never signed in to TimeOff; imported as active, like any current employee.` });
  }
  const departmentId = u.departmentId !== null ? (c.departmentKey.get(u.departmentId) ?? null) : null;
  // Midday UTC, so the date is the same in every company time zone the rollover reads it in.
  const startedBy = u.startDate !== null && u.startDate <= c.today ? `${u.startDate}T12:00:00.000Z` : null;
  // Someone not started yet joined (for the rollover) no earlier than this year: they carry nothing into it.
  const notStartedYet = u.startDate !== null && u.startDate > c.today;
  return {
    key: u.id,
    email,
    name,
    role: u.admin ? "admin" : c.managers.has(u.id) ? "manager" : "employee",
    departmentKey: departmentId,
    managerKey: c.managerOf.get(u.id) ?? null,
    canSelfApprove: u.autoApprove,
    isActive,
    createdAt: startedBy ?? (notStartedYet || !u.createdAt ? `${c.today}T12:00:00.000Z` : u.createdAt),
  };
}

/** The company's people: one per email, the rest reported as conflicts. */
export function planPeople(
  scope: CompanyScope,
  departments: { departmentKey: ReadonlyMap<number, number>; departmentById: ReadonlyMap<number, TimeOffDepartment> },
  today: CalendarDate,
  warn: Warn,
  conflicts: ImportIssue[],
): PeoplePlan {
  const isActive = timeOffEmployed(today);
  const grouped = groupByEmail(scope.users, conflicts);
  const { kept, personOf, skipped } = keepPerEmail(grouped.groups, isActive, scope.leaveCount, conflicts);
  const managerOf = managersOf(kept, departments.departmentById, personOf, warn);
  const managers = new Set([...managerOf.values()].filter((m): m is number => m !== null));
  const context = { today, isActive, departmentKey: departments.departmentKey, managerOf, managers };
  const people = kept.map((k) => toPlannedPerson(k, context, warn));
  return { people, kept, keptIds: new Set(kept.map((k) => k.user.id)), personOf, skippedUsers: grouped.skipped + skipped };
}
