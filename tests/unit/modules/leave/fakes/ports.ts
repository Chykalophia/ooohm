import type { Actor } from "@/domain/actor";
import { assertCovered, type Balance } from "@/domain/allowance-policy";
import { type ApprovalContext, ManagerApprovalRule, reassignApprover } from "@/domain/approval-rule";
import type { ChangeSource } from "@/domain/change-source";
import { DomainError } from "@/domain/errors";
import { eventAttribution } from "@/domain/events";
import type { AlsoOff } from "@/modules/leave/application/queries/also-off";
import type {
  AllowanceReader,
  AlsoOffReader,
  ApprovalRouter,
  ChangeLog,
  Clock,
  CompanyFacts,
  CompanySettings,
  Contact,
  Department,
  LeaveDeps,
  LeaveDirectory,
  LeaveStore,
  Person,
  Requester,
} from "@/modules/leave/application/ports";
import type { Notification } from "@/modules/notifications";
import type { AuditEntry, OutboxEvent } from "@/shared/lib/db/change-log";
import type { LeaveTypeSettingsDTO as LeaveTypeRow } from "@/modules/organisation";
import type { LeaveTypeWithAllowance } from "@/server/services/balances";
import { type IdGenerator, sequenceIds } from "@/shared/lib/id-generator";
import { splitLeaveDaysByYear } from "@/shared/kernel/leave-days";
import { InMemoryLeaveRequestRepository } from "./in-memory-leave-request.repository";

/** A clock that says what it is told. */
export class FixedClock implements Clock {
  constructor(private instant: Date) {}
  now(): Date {
    return this.instant;
  }
  set(instant: Date): void {
    this.instant = instant;
  }
  advance(ms: number): void {
    this.instant = new Date(this.instant.getTime() + ms);
  }
}

/** Every audit row written, with its source. */
export class RecordingAudit {
  readonly entries: (AuditEntry & { source: ChangeSource })[] = [];
}

/** Every outbox event published, with its attribution added as `recordChange` adds it. */
export class RecordingOutbox {
  readonly events: OutboxEvent[] = [];
  /** Event types in order, e.g. `["leave.requested", "leave.approved"]`. */
  types(): string[] {
    return this.events.map((e) => e.type);
  }
}

/** A {@link ChangeLog} that writes into the two recorders together, as one unit. */
export function recordingChangeLog(audit: RecordingAudit, outbox: RecordingOutbox): ChangeLog {
  return {
    record: async ({ source, audit: entry, event }) => {
      audit.entries.push({ ...entry, source });
      outbox.events.push({ ...event, payload: { ...event.payload, ...eventAttribution(source) } });
    },
  };
}

export const COMPANY = "00000000-0000-4000-8000-00000000c001";
export const OTHER_COMPANY = "00000000-0000-4000-8000-00000000c002";
export const VACATION = "00000000-0000-4000-8000-0000000000a1";

export const ANA = "00000000-0000-4000-8000-0000000000b1";
export const MO = "00000000-0000-4000-8000-0000000000b2";
export const BOSS = "00000000-0000-4000-8000-0000000000b3";
export const CY = "00000000-0000-4000-8000-0000000000b4";

/** A person of {@link COMPANY}, active, with no manager or department unless given. */
export function person(id: string, name: string, over: Partial<Person> = {}): Person {
  return {
    id,
    name,
    email: `${name.toLowerCase()}@example.test`,
    role: "employee",
    departmentId: null,
    levelId: null,
    managerId: null,
    canSelfApprove: false,
    isActive: true,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    scrubScheduledAt: null,
    ...over,
  };
}

export function leaveType(over: Partial<LeaveTypeRow> = {}): LeaveTypeRow & LeaveTypeWithAllowance {
  return {
    id: VACATION,
    name: "Vacation",
    code: "VAC",
    color: "#0f766e",
    isPaid: true,
    countsAgainstAllowance: true,
    defaultAllowanceDays: 20,
    carryoverEnabled: false,
    carryoverMaxDays: null,
    sortOrder: 0,
    archivedAt: null,
    archived: false,
    ...over,
  } as LeaveTypeRow & LeaveTypeWithAllowance;
}

/** The company, its people, departments and leave types, in memory. */
export class InMemoryDirectory implements LeaveDirectory {
  settings: CompanySettings = { timezone: "UTC", workingDays: [1, 2, 3, 4, 5], allowancePolicy: "annual_calendar_year", approvalMode: "required", departmentScoping: false };
  managersSeeDetails = true;
  holidays: string[] = [];
  readonly people = new Map<string, Person>();
  readonly departments = new Map<string, Department>();
  readonly types = new Map<string, LeaveTypeRow & LeaveTypeWithAllowance>([[VACATION, leaveType()]]);
  readonly locks: string[] = [];

  add(...people: Person[]): this {
    for (const p of people) this.people.set(p.id, p);
    return this;
  }
  async shareLockCompany(companyId: string) {
    this.locks.push(`company:${companyId}`);
  }
  async companySettings(companyId: string) {
    return companyId === COMPANY ? this.settings : undefined;
  }
  async company(companyId: string): Promise<CompanyFacts | undefined> {
    return companyId === COMPANY ? { timezone: this.settings.timezone, allowancePolicy: this.settings.allowancePolicy, managersSeeDetails: this.managersSeeDetails } : undefined;
  }
  async holidayDates(_companyId: string, from: string, to: string) {
    return this.holidays.filter((d) => d >= from && d <= to);
  }
  async lockMember(companyId: string, userId: string): Promise<Requester | undefined> {
    this.locks.push(`member:${userId}`);
    return this.findPerson(companyId, userId);
  }
  async lockPerson(companyId: string, userId: string) {
    this.locks.push(`member:${userId}`);
    return this.findPerson(companyId, userId);
  }
  async findPerson(companyId: string, userId: string) {
    return companyId === COMPANY ? this.people.get(userId) : undefined;
  }
  async department(_companyId: string, id: string) {
    return this.departments.get(id);
  }
  async contacts(_companyId: string, ids: readonly string[]): Promise<Contact[]> {
    return ids.flatMap((id) => {
      const p = this.people.get(id);
      return p ? [{ id: p.id, name: p.name, email: p.email, isActive: p.isActive }] : [];
    });
  }
  async leaveType(_companyId: string, id: string) {
    const t = this.types.get(id);
    return t && { id: t.id, name: t.name };
  }
  async leaveTypeForAdmin(_companyId: string, id: string) {
    return this.types.get(id);
  }
  async leaveTypesWithAllowance() {
    return [...this.types.values()];
  }
}

/** A tracked balance with `remaining` days left. */
export function balanceWith(remaining: number, allowance = 20): Balance {
  const used = allowance - remaining;
  return { tracked: true, allowance, carriedOver: 0, adjustment: 0, total: allowance, used, pending: 0, carriedOut: 0, remaining };
}

/**
 * Balances in memory: counts a draft with the directory's working days and holidays
 * (as the real assessment does) and charges it against {@link remaining} days a year,
 * refusing a shortfall with the real `assertCovered`.
 */
export class InMemoryAllowanceReader implements AllowanceReader {
  /** Days left before a request, by year; years not listed have 20. */
  remaining = new Map<number, number>();
  readonly recarried: unknown[] = [];

  constructor(private readonly directory: InMemoryDirectory) {}

  balanceFor(year: number): Balance {
    return balanceWith(this.remaining.get(year) ?? 20);
  }
  async assess(_person: { id: string; companyId: string }, draft: { leaveTypeId: string; startDate: string; endDate?: string | null; dayPortion: "full" | "am" | "pm" }) {
    const type = this.directory.types.get(draft.leaveTypeId);
    if (!type || type.archived) throw new DomainError("leave_type_unavailable");
    const range = { startDate: draft.startDate, endDate: draft.endDate || draft.startDate, dayPortion: draft.dayPortion };
    const split = splitLeaveDaysByYear(range, { workingDays: this.directory.settings.workingDays, holidays: this.directory.holidays });
    if (split.length === 0) throw new DomainError("zero_days");
    const charges = split.map(({ year, days }) => ({ year, days, before: this.balanceFor(year) }));
    assertCovered(charges);
    return { range, leaveType: { id: type.id, name: type.name }, days: split.reduce((s, y) => s + y.days, 0), charges };
  }
  async summarize(_person: { id: string; companyId: string }, loaded: { types: readonly LeaveTypeWithAllowance[]; year: number }) {
    return {
      year: loaded.year,
      items: loaded.types.map((t) => ({ leaveTypeId: t.id, name: t.name, color: t.color, balance: this.balanceFor(loaded.year), archived: t.archived, row: null })),
    };
  }
  async balancesFor() {
    return { balance: (_policy: unknown, _type: unknown, _userId: string, year: number) => this.balanceFor(year) } as unknown as Awaited<ReturnType<AllowanceReader["balancesFor"]>>;
  }
  async recarry(job: unknown) {
    this.recarried.push(job);
  }
}

/** Approval routing from a fixed table: each requester's manager (or `null`), and the company's admins. */
export class FakeApprovalRouter implements ApprovalRouter {
  constructor(private readonly directory: InMemoryDirectory) {}
  async contextFor(_companyId: string, requester: Requester): Promise<ApprovalContext> {
    const candidate = (id: string | null) => {
      const p = id ? this.directory.people.get(id) : undefined;
      return p && p.id !== requester.id ? p : null;
    };
    const admins = [...this.directory.people.values()].filter((p) => p.role === "admin" && p.isActive);
    return { requester, manager: candidate(requester.managerId), departmentManager: null, admins };
  }
  async currentApprover(companyId: string, requesterId: string) {
    const requester = this.directory.people.get(requesterId);
    return requester ? reassignApprover(new ManagerApprovalRule(), await this.contextFor(companyId, requester)) : null;
  }
}

/** Who else is off: always the line it is given. */
export class FakeAlsoOff implements AlsoOffReader {
  line: AlsoOff = { others: 0, line: "Nobody else is off then.", coverage: null };
  readonly asked: { readerId?: string }[] = [];
  async lines(_companyId: string, requests: readonly { id: string }[], readerId?: string) {
    this.asked.push({ readerId });
    return new Map(requests.map((r) => [r.id, this.line]));
  }
}

/** Everything a use-case test runs against, and the fakes to look into. */
export interface LeaveKit {
  deps: LeaveDeps;
  clock: FixedClock;
  ids: IdGenerator;
  requests: InMemoryLeaveRequestRepository;
  directory: InMemoryDirectory;
  allowances: InMemoryAllowanceReader;
  approvals: FakeApprovalRouter;
  alsoOff: FakeAlsoOff;
  audit: RecordingAudit;
  outbox: RecordingOutbox;
  /** Emails each committed unit of work queued, in order. */
  sent: Notification[];
  /** Units of work run, and how many rolled back (threw). */
  units: { run: number; rolledBack: number };
}

/**
 * Fakes for every leave port. A unit of work commits by copying its writes into the
 * shared fakes only when it does not throw, like a transaction: a use case that writes
 * and then fails leaves nothing behind.
 */
export function leaveKit(now = new Date("2026-11-02T10:00:00Z")): LeaveKit {
  const clock = new FixedClock(now);
  const ids = sequenceIds();
  const directory = new InMemoryDirectory();
  const requests = new InMemoryLeaveRequestRepository(clock, { leaveTypes: { [VACATION]: { name: "Vacation", color: "#0f766e" } }, people: {} });
  const allowances = new InMemoryAllowanceReader(directory);
  const approvals = new FakeApprovalRouter(directory);
  const alsoOff = new FakeAlsoOff();
  const audit = new RecordingAudit();
  const outbox = new RecordingOutbox();
  const sent: Notification[] = [];
  const units = { run: 0, rolledBack: 0 };
  const store: LeaveStore = { requests, directory, allowances, approvals, changes: recordingChangeLog(audit, outbox), alsoOff };
  const deps: LeaveDeps = {
    clock,
    ids,
    appUrl: "https://ooohm.test",
    approveLink: (requestId, approverId) => `https://ooohm.test/approve/${requestId}.${approverId}`,
    read: store,
    unitOfWork: async (_companyId, work) => {
      units.run++;
      const snapshot = { rows: new Map(requests.rows), days: new Map(requests.yearDays), audit: audit.entries.length, events: outbox.events.length };
      try {
        const { result, notify } = await work(store);
        sent.push(...notify);
        return result;
      } catch (error) {
        units.rolledBack++;
        requests.rows.clear();
        for (const [k, v] of snapshot.rows) requests.rows.set(k, v);
        requests.yearDays.clear();
        for (const [k, v] of snapshot.days) requests.yearDays.set(k, v);
        audit.entries.length = snapshot.audit;
        outbox.events.length = snapshot.events;
        throw error;
      }
    },
  };
  return { deps, clock, ids, requests, directory, allowances, approvals, alsoOff, audit, outbox, sent, units };
}

/** An actor for `p`, acting as themself. */
export function actorFor(p: Person): Actor {
  return { id: p.id, companyId: COMPANY, role: p.role, canSelfApprove: p.canSelfApprove, source: { kind: "user", userId: p.id } };
}
