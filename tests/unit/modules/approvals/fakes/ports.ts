import type { Actor, Role } from "@/shared/kernel/actor";
import type { ChangeSource } from "@/shared/kernel/change-source";
import type {
  ApprovalChangeLog,
  ApprovalContextReader,
  ApprovalDeps,
  ApprovalDirectory,
  ApprovalInbox,
  ApprovalRequests,
  ApprovalStore,
  Contact,
  InboxRequest,
  InboxScope,
  ReviewRequest,
  RoutingRequester,
} from "@/modules/approvals/application/ports";
import type { ApprovalContext } from "@/modules/approvals/domain/approval-context";
import type { LeaveRequest } from "@/modules/leave/domain/leave-request";
import type { Notification } from "@/modules/notifications";
import { InMemoryLeaveRequestRepository } from "../../leave/fakes/in-memory-leave-request.repository";
import { FixedClock } from "../../leave/fakes/ports";

export const COMPANY = "00000000-0000-4000-8000-00000000c001";
export const VACATION = "00000000-0000-4000-8000-0000000000a1";

/** A person as routing and email see them. */
export interface FakePerson {
  id: string;
  companyId: string;
  name: string;
  email: string;
  role: Role;
  canSelfApprove: boolean;
  managerId: string | null;
  departmentId: string | null;
  isActive: boolean;
  createdAt: Date;
}

/** People and departments in memory: what routing reads. */
export class InMemoryApprovalContextReader implements ApprovalContextReader {
  readonly people = new Map<string, FakePerson>();
  /** Department id → its manager's id, or `null`. */
  readonly departments = new Map<string, string | null>();

  async requesters(companyId: string, ids: readonly string[]): Promise<RoutingRequester[]> {
    return ids.flatMap((id) => {
      const p = this.people.get(id);
      return p && p.companyId === companyId ? [p] : [];
    });
  }

  async contextsFor(companyId: string, requesters: readonly RoutingRequester[]): Promise<Map<string, ApprovalContext>> {
    const admins = [...this.people.values()]
      .filter((p) => p.companyId === companyId && p.role === "admin" && p.isActive)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    const candidate = (id: string | null | undefined, requesterId: string) => {
      const p = id && id !== requesterId ? this.people.get(id) : undefined;
      return p && p.companyId === companyId ? p : null;
    };
    return new Map(
      requesters.map((r) => [
        r.id,
        {
          requester: r,
          manager: candidate(r.managerId, r.id),
          departmentManager: candidate(r.departmentId ? this.departments.get(r.departmentId) : null, r.id),
          admins,
        },
      ]),
    );
  }
}

/** Every decision and reassignment written, with who made it. */
export class RecordingApprovalChanges implements ApprovalChangeLog {
  readonly written: { kind: string; before: LeaveRequest | null; after: LeaveRequest; source: ChangeSource }[] = [];
  async decision(change: { event: string; before: LeaveRequest | null; after: LeaveRequest; source: ChangeSource }) {
    this.written.push({ kind: change.event, before: change.before, after: change.after, source: change.source });
  }
  async reassignment(change: { before: LeaveRequest; after: LeaveRequest; source: ChangeSource }) {
    this.written.push({ kind: "reassigned", ...change });
  }
  kinds(): string[] {
    return this.written.map((w) => w.kind);
  }
}

/** Everything a use-case test runs against, and the fakes to look into. */
export interface ApprovalKit {
  deps: ApprovalDeps;
  clock: FixedClock;
  requests: InMemoryLeaveRequestRepository;
  contexts: InMemoryApprovalContextReader;
  changes: RecordingApprovalChanges;
  sent: Notification[];
  units: { run: number; rolledBack: number };
  /** Adds people (each in {@link COMPANY}, active, an employee unless given). */
  add(id: string, name: string, over?: Partial<FakePerson>): FakePerson;
  /** Stores a request as it would be after a submit, pending with `approverId` unless given. */
  request(userId: string, approverId: string | null, over?: Partial<LeaveRequest>): LeaveRequest;
  as(id: string, over?: Partial<Actor>): Actor;
}

function directoryOn(contexts: InMemoryApprovalContextReader): ApprovalDirectory {
  return {
    activeContacts: async (_companyId, ids) => {
      const found: [string, Contact][] = ids.flatMap((id) => {
        const p = id ? contexts.people.get(id) : undefined;
        return p?.isActive ? [[p.id, { id: p.id, name: p.name, email: p.email }] as [string, Contact]] : [];
      });
      return new Map(found);
    },
    leaveTypeName: async (_companyId, id) => (id === VACATION ? "Vacation" : undefined),
    leaveTypeNames: async () => new Map([[VACATION, "Vacation"]]),
    linkPerson: async (userId) => contexts.people.get(userId),
    timezone: async () => "UTC",
  };
}

function requestsOn(rows: InMemoryLeaveRequestRepository, contexts: InMemoryApprovalContextReader): ApprovalRequests {
  return {
    lock: (companyId, id) => rows.lock(companyId, id),
    decideIfCurrent: (where, set) => rows.updateStatusIfCurrent(where, set),
    reassignIfCurrent: (where, approverId) => rows.reassignIfCurrent(where, approverId),
    findForReview: async (companyId, id): Promise<ReviewRequest | undefined> => {
      const r = await rows.find(companyId, id);
      const who = r && contexts.people.get(r.userId);
      if (!r || !who) return undefined;
      const { status, approverId, startDate, endDate, dayPortion, days, note } = r;
      return { id, status, approverId, startDate, endDate, dayPortion, days, note, leaveTypeName: "Vacation", leaveTypeColor: "#0f766e", requesterName: who.name, requesterEmail: who.email };
    },
  };
}

/** The inbox the use cases read: pending requests by assignment, as `inboxWhere` picks them. */
function inboxOn(rows: InMemoryLeaveRequestRepository, contexts: InMemoryApprovalContextReader): ApprovalInbox {
  const visible = (scope: InboxScope) =>
    [...rows.rows.values()].filter((r) => {
      if (r.companyId !== scope.companyId || r.status !== "pending") return false;
      const own = r.userId === scope.deciderId;
      const mine = r.approverId === scope.deciderId;
      if (!scope.isAdmin) return scope.part !== "others" && mine && !own;
      if (scope.part === "mine") return mine || (r.approverId === null && !own);
      if (scope.part === "others") return r.approverId !== null && !mine && !own;
      return mine || !own;
    });
  const toInbox = (r: LeaveRequest): InboxRequest => {
    const who = contexts.people.get(r.userId)!;
    return {
      ...r,
      cursor: r.createdAt.toISOString(),
      leaveTypeName: "Vacation",
      leaveTypeColor: "#0f766e",
      requesterId: r.userId,
      requesterName: who.name,
      requesterEmail: who.email,
      requesterDepartmentId: who.departmentId,
      requesterDepartmentName: null,
      approverName: r.approverId ? (contexts.people.get(r.approverId)?.name ?? null) : null,
    };
  };
  return {
    list: async (scope, limit) => visible(scope).slice(0, limit).map(toInbox),
    count: async (scope) => visible(scope).length,
    recentDecisions: async () => [],
    alsoOff: async (_companyId, requests) => new Map(requests.map((r) => [r.id, { others: 0, line: "Nobody else is off then.", coverage: null }])),
  };
}

/**
 * Fakes for every approvals port. A unit of work keeps its writes only when it does not
 * throw, like a transaction.
 */
export function approvalKit(now = new Date("2026-11-02T10:00:00Z")): ApprovalKit {
  const clock = new FixedClock(now);
  const requests = new InMemoryLeaveRequestRepository(clock);
  const contexts = new InMemoryApprovalContextReader();
  const changes = new RecordingApprovalChanges();
  const sent: Notification[] = [];
  const units = { run: 0, rolledBack: 0 };
  const store: ApprovalStore = { requests: requestsOn(requests, contexts), contexts, directory: directoryOn(contexts), changes, inbox: inboxOn(requests, contexts) };
  const deps: ApprovalDeps = {
    linkKey: "test-link-key",
    appUrl: "https://ooohm.test",
    now: () => clock.now(),
    read: store,
    unitOfWork: async (_companyId, work) => {
      units.run++;
      const rows = new Map(requests.rows);
      const written = changes.written.length;
      try {
        const { result, notify } = await work(store);
        sent.push(...notify);
        return result;
      } catch (error) {
        units.rolledBack++;
        requests.rows.clear();
        for (const [k, v] of rows) requests.rows.set(k, v);
        changes.written.length = written;
        throw error;
      }
    },
  };
  let seq = 0;
  return {
    deps,
    clock,
    requests,
    contexts,
    changes,
    sent,
    units,
    add(id, name, over = {}) {
      const p: FakePerson = {
        id,
        companyId: COMPANY,
        name,
        email: `${name.toLowerCase()}@example.test`,
        role: "employee",
        canSelfApprove: false,
        managerId: null,
        departmentId: null,
        isActive: true,
        createdAt: new Date("2025-01-01T00:00:00Z"),
        ...over,
      };
      contexts.people.set(id, p);
      return p;
    },
    request(userId, approverId, over = {}) {
      seq++;
      const r: LeaveRequest = {
        id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
        companyId: COMPANY,
        userId,
        leaveTypeId: VACATION,
        startDate: "2026-11-09",
        endDate: "2026-11-10",
        dayPortion: "full",
        days: 2,
        note: null,
        status: "pending",
        approverId,
        decidedAt: null,
        decisionNote: null,
        createdAt: new Date(now.getTime() + seq),
        updatedAt: new Date(now.getTime() + seq),
        ...over,
      };
      requests.rows.set(r.id, r);
      return r;
    },
    as(id, over = {}) {
      const p = contexts.people.get(id)!;
      return { id: p.id, companyId: p.companyId, role: p.role, canSelfApprove: p.canSelfApprove, source: { kind: "user", userId: p.id }, ...over };
    },
  };
}
