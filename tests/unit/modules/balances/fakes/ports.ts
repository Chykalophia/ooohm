import type { Actor } from "@/shared/kernel/actor";
import type { CalendarDate } from "@/shared/kernel/calendar-date";
import { DomainError } from "@/shared/kernel/errors";
import type {
  AdminLeaveType,
  AllowanceRuleRepository,
  BalancesCompany,
  BalancesDeps,
  BalancesDirectory,
  BalancesStore,
  ChangeLog,
  StoredAllowanceRule,
} from "@/modules/balances/application/ports";
import type { Placement } from "@/modules/balances/domain/allowance-rules";
import { ANNUAL_CALENDAR_YEAR } from "@/shared/kernel/allowance-policy-keys";
import { FixedClock, RecordingAudit, RecordingOutbox, recordingChangeLog } from "../../leave/fakes/ports";
import { InMemoryAllowanceRepository } from "./in-memory-allowance.repository";

export const COMPANY = "00000000-0000-4000-8000-00000000c001";
export const VACATION = "00000000-0000-4000-8000-0000000000a1";
export const SICK = "00000000-0000-4000-8000-0000000000a2";
export const ANA = "00000000-0000-4000-8000-0000000000b1";
export const BO = "00000000-0000-4000-8000-0000000000b2";
export const BOSS = "00000000-0000-4000-8000-0000000000b3";
export const DEV = "00000000-0000-4000-8000-0000000000d1";
export const SENIOR = "00000000-0000-4000-8000-0000000000e1";

/** A person as the directory fake holds them. */
export interface FakePerson {
  id: string;
  role: Actor["role"];
  isActive: boolean;
  createdAt: Date;
  departmentId: string | null;
  levelId: string | null;
}

export function person(id: string, over: Partial<FakePerson> = {}): FakePerson {
  return { id, role: "employee", isActive: true, createdAt: new Date("2024-01-01T00:00:00Z"), departmentId: null, levelId: null, ...over };
}

/** A leave type of {@link COMPANY}: counted, 20 days, no carryover, unless given. */
export function leaveType(over: Partial<AdminLeaveType> = {}): AdminLeaveType {
  return {
    id: VACATION,
    name: "Vacation",
    code: "VAC",
    color: "#0f766e",
    countsAgainstAllowance: true,
    defaultAllowanceDays: 20,
    carryoverEnabled: false,
    carryoverMaxDays: null,
    archivedAt: null,
    ...over,
  };
}

/** The company, its people, leave types, departments and levels, in memory. */
export class InMemoryBalancesDirectory implements BalancesDirectory {
  company_: BalancesCompany = { id: COMPANY, timezone: "UTC", workingDays: [1, 2, 3, 4, 5], allowancePolicy: ANNUAL_CALENDAR_YEAR };
  holidayList: { date: CalendarDate; name: string }[] = [];
  readonly people = new Map<string, FakePerson>();
  readonly types = new Map<string, AdminLeaveType>([[VACATION, leaveType()]]);
  readonly departmentList = [{ id: DEV, name: "Dev" }];
  readonly levelList = [{ id: SENIOR, name: "Senior" }];
  readonly locks: string[] = [];

  add(...people: FakePerson[]): this {
    for (const p of people) this.people.set(p.id, p);
    return this;
  }
  type(t: AdminLeaveType): this {
    this.types.set(t.id, t);
    return this;
  }
  async companies() {
    return [this.company_];
  }
  async company(companyId: string) {
    return companyId === COMPANY ? this.company_ : undefined;
  }
  async lockCompany(companyId: string) {
    this.locks.push(`company:${companyId}`);
    return this.company(companyId);
  }
  async assertActiveAdmin(actor: Actor) {
    const me = this.people.get(actor.id);
    if (actor.role !== "admin" || !me?.isActive || me.role !== "admin") throw new DomainError("forbidden");
  }
  async holidayDates(_companyId: string, from: string, to: string) {
    return this.holidayList.map((h) => h.date).filter((d) => d >= from && d <= to);
  }
  async holidays(_companyId: string, from: string, to: string) {
    return this.holidayList.filter((h) => h.date >= from && h.date <= to);
  }
  async activeRequestsInRange() {
    return [];
  }
  private withAllowance(t: AdminLeaveType) {
    return { id: t.id, name: t.name, code: t.code, color: t.color, countsAgainstAllowance: t.countsAgainstAllowance, defaultAllowanceDays: t.defaultAllowanceDays, carryoverEnabled: t.carryoverEnabled, carryoverMaxDays: t.carryoverMaxDays };
  }
  async activeLeaveType(_companyId: string, id: string) {
    const t = this.types.get(id);
    return t && t.archivedAt === null ? this.withAllowance(t) : undefined;
  }
  async activeLeaveTypes() {
    return [...this.types.values()].filter((t) => t.archivedAt === null).map((t) => this.withAllowance(t));
  }
  async leaveTypesWithAllowance() {
    return [...this.types.values()].map((t) => ({ ...this.withAllowance(t), archived: t.archivedAt !== null }));
  }
  async leaveTypeForAdmin(_companyId: string, id: string) {
    return this.types.get(id);
  }
  async allLeaveTypes() {
    return [...this.types.values()];
  }
  async activeMembers() {
    return [...this.people.values()].filter((p) => p.isActive).map(({ id, createdAt }) => ({ id, createdAt }));
  }
  async lockMember(_companyId: string, userId: string) {
    this.locks.push(`member:${userId}`);
    const p = this.people.get(userId);
    return p && { id: p.id, isActive: p.isActive, createdAt: p.createdAt };
  }
  async lockMembers(_companyId: string, userIds: readonly string[]) {
    for (const id of userIds) this.locks.push(`member:${id}`);
  }
  async departments() {
    return this.departmentList;
  }
  async department(_companyId: string, id: string) {
    return this.departmentList.find((d) => d.id === id);
  }
  async levels() {
    return this.levelList;
  }
  async level(_companyId: string, id: string) {
    return this.levelList.find((l) => l.id === id);
  }
}

/** Allowance rules in memory; where people sit comes from the directory. */
export class InMemoryAllowanceRuleRepository implements AllowanceRuleRepository {
  readonly rules: StoredAllowanceRule[] = [];
  private next = 1;

  constructor(private readonly directory: InMemoryBalancesDirectory) {}

  async list(_companyId: string, leaveTypeId?: string) {
    return this.rules.filter((r) => !leaveTypeId || r.leaveTypeId === leaveTypeId).map((r) => ({ ...r }));
  }
  async find(_companyId: string, id: string) {
    return this.rules.find((r) => r.id === id);
  }
  async findFor(_companyId: string, leaveTypeId: string, target: Placement) {
    return this.rules.find((r) => r.leaveTypeId === leaveTypeId && r.departmentId === target.departmentId && r.levelId === target.levelId);
  }
  async insert(values: { leaveTypeId: string; departmentId: string | null; levelId: string | null; days: number }) {
    const rule = { id: `00000000-0000-4000-8000-${String(this.next++).padStart(12, "0")}`, leaveTypeId: values.leaveTypeId, departmentId: values.departmentId, levelId: values.levelId, days: values.days };
    this.rules.push(rule);
    return { ...rule };
  }
  async updateDays(_companyId: string, id: string, days: number) {
    const rule = this.rules.find((r) => r.id === id)!;
    rule.days = days;
    return { ...rule };
  }
  async delete(_companyId: string, id: string) {
    const i = this.rules.findIndex((r) => r.id === id);
    if (i >= 0) this.rules.splice(i, 1);
  }
  async placements(_companyId: string, userIds: readonly string[]) {
    return new Map(
      userIds.flatMap((id) => {
        const p = this.directory.people.get(id);
        return p ? [[id, { departmentId: p.departmentId, levelId: p.levelId }] as const] : [];
      }),
    );
  }
  async membersAt(_companyId: string, target: Placement) {
    return [...this.directory.people.values()]
      .filter((p) => (!target.departmentId || p.departmentId === target.departmentId) && (!target.levelId || p.levelId === target.levelId))
      .map((p) => p.id)
      .sort();
  }
}

/** {@link recordingChangeLog}, plus admin changes recorded as `recordAdminChange` records them. */
export function recordingBalancesChangeLog(audit: RecordingAudit, outbox: RecordingOutbox): ChangeLog {
  const log = recordingChangeLog(audit, outbox);
  return {
    record: log.record,
    recordAdmin: (actor, change) =>
      log.record({
        source: actor.source,
        audit: {
          companyId: actor.companyId,
          action: change.type,
          entityType: change.entityType,
          entityId: change.entityId,
          subjectUserId: change.subjectUserId ?? null,
          before: change.before,
          after: change.after,
        },
        event: { companyId: actor.companyId, type: change.type, payload: change.payload as Record<string, unknown> },
      }),
  };
}

/** Everything a balances use-case test runs against, and the fakes to look into. */
export interface BalancesKit {
  deps: BalancesDeps;
  clock: FixedClock;
  allowances: InMemoryAllowanceRepository;
  rules: InMemoryAllowanceRuleRepository;
  directory: InMemoryBalancesDirectory;
  audit: RecordingAudit;
  outbox: RecordingOutbox;
  /** Units of work run, and how many rolled back (threw). */
  units: { run: number; rolledBack: number };
}

/**
 * Fakes for every balances port. A unit of work that throws puts the allowance rows,
 * rules, audit rows and events back as they were, like a transaction.
 */
export function balancesKit(now = new Date("2027-01-04T10:00:00Z")): BalancesKit {
  const clock = new FixedClock(now);
  let n = 0;
  const allowances = new InMemoryAllowanceRepository(() => COMPANY, () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`);
  const directory = new InMemoryBalancesDirectory();
  const rules = new InMemoryAllowanceRuleRepository(directory);
  const audit = new RecordingAudit();
  const outbox = new RecordingOutbox();
  const units = { run: 0, rolledBack: 0 };
  const store: BalancesStore = { allowances, rules, directory, changes: recordingBalancesChangeLog(audit, outbox) };
  const deps: BalancesDeps = {
    clock,
    read: store,
    unitOfWork: async (work) => {
      units.run++;
      const snapshot = {
        rows: new Map([...allowances.rows].map(([k, v]) => [k, { ...v }])),
        rules: rules.rules.map((r) => ({ ...r })),
        audit: audit.entries.length,
        events: outbox.events.length,
      };
      try {
        return await work(store);
      } catch (error) {
        units.rolledBack++;
        allowances.rows.clear();
        for (const [k, v] of snapshot.rows) allowances.rows.set(k, v);
        rules.rules.splice(0, rules.rules.length, ...snapshot.rules);
        audit.entries.length = snapshot.audit;
        outbox.events.length = snapshot.events;
        throw error;
      }
    },
  };
  return { deps, clock, allowances, rules, directory, audit, outbox, units };
}

/** An actor for `p`, acting as themself. */
export function actorFor(p: FakePerson): Actor {
  return { id: p.id, companyId: COMPANY, role: p.role, canSelfApprove: false, source: { kind: "user", userId: p.id } };
}
