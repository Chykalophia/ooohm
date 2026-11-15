import type { ApiLeaveRequest, ApiLeaveRequestPage, Clock, LeaveRequestRepository, OwnRequest } from "@/modules/leave/application/ports";
import type { LeaveRequest } from "@/modules/leave/domain/leave-request";
import type { YearDays } from "@/shared/kernel/leave-days";
import { ACTIVE_STATUSES } from "@/shared/kernel/leave-range";

/** Names the own-request reads join in. */
export interface Catalog {
  leaveTypes: Record<string, { name: string; color: string }>;
  people: Record<string, { name: string }>;
}

const isActive = (r: LeaveRequest) => (ACTIVE_STATUSES as readonly string[]).includes(r.status);
/** The request without what the API never shows. */
const toApi = (r: LeaveRequest): ApiLeaveRequest => {
  const copy: { -readonly [K in keyof LeaveRequest]?: LeaveRequest[K] } = { ...r };
  delete copy.note;
  delete copy.decisionNote;
  delete copy.companyId;
  return copy as ApiLeaveRequest;
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * {@link LeaveRequestRepository} in memory, for use-case tests. It passes the same
 * contract suite as the Drizzle repository (`leaveRequestRepositoryContract`), which is
 * what keeps it honest. Timestamps come from `clock`; locks are no-ops.
 */
export class InMemoryLeaveRequestRepository implements LeaveRequestRepository {
  readonly rows = new Map<string, LeaveRequest>();
  readonly yearDays = new Map<string, YearDays[]>();

  constructor(
    private readonly clock: Clock,
    private readonly catalog: Catalog = { leaveTypes: {}, people: {} },
  ) {}

  async find(companyId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.companyId === companyId ? row : undefined;
  }

  lock(companyId: string, id: string) {
    return this.find(companyId, id);
  }

  async countRecentByRequester(userId: string, minutes: number) {
    const since = this.clock.now().getTime() - minutes * 60_000;
    return [...this.rows.values()].filter((r) => r.userId === userId && r.createdAt.getTime() > since).length;
  }

  async findActiveOverlapping(userId: string, range: { startDate: string; endDate: string }) {
    return [...this.rows.values()]
      .filter((r) => r.userId === userId && isActive(r) && r.startDate <= range.endDate && r.endDate >= range.startDate)
      .map(({ startDate, endDate, dayPortion }) => ({ startDate, endDate, dayPortion }));
  }

  async insert(request: LeaveRequest) {
    const now = this.clock.now();
    const stored: LeaveRequest = { ...request, decidedAt: null, createdAt: now, updatedAt: now };
    this.rows.set(stored.id, stored);
    return stored;
  }

  async saveYearDays(requestId: string, split: readonly YearDays[]) {
    if (split.length > 0) this.yearDays.set(requestId, split.map(({ year, days }) => ({ year, days })));
  }

  async updateStatusIfCurrent(
    where: { companyId: string; id: string; from: LeaveRequest["status"] },
    set: { status: LeaveRequest["status"]; decidedAt?: Date; decisionNote?: string | null },
  ) {
    const row = await this.find(where.companyId, where.id);
    if (!row || row.status !== where.from) return undefined;
    const next: LeaveRequest = { ...row, ...set, updatedAt: this.clock.now() };
    this.rows.set(row.id, next);
    return next;
  }

  async lockActiveOnDates(companyId: string, dates: readonly string[] | { from: string }) {
    const hits = (r: LeaveRequest) => ("from" in dates ? r.endDate >= dates.from : dates.some((d) => r.startDate <= d && d <= r.endDate));
    return [...this.rows.values()]
      .filter((r) => r.companyId === companyId && isActive(r) && hits(r))
      .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));
  }

  async listYearDays(requestIds: readonly string[]) {
    return new Map(requestIds.flatMap((id) => (this.yearDays.has(id) ? [[id, this.yearDays.get(id) as YearDays[]] as const] : [])));
  }

  async replaceYearDays(requestId: string, split: readonly YearDays[]) {
    this.yearDays.delete(requestId);
    await this.saveYearDays(requestId, split);
  }

  async updateDays(companyId: string, id: string, days: number) {
    const row = await this.find(companyId, id);
    if (!row) throw new Error(`leave request ${id} missing while its days were updated`);
    const next = { ...row, days, updatedAt: this.clock.now() };
    this.rows.set(id, next);
    return next;
  }

  async listOwn(companyId: string, userId: string, limit: number): Promise<OwnRequest[]> {
    return [...this.rows.values()]
      .filter((r) => r.companyId === companyId && r.userId === userId)
      .sort((a, b) => b.startDate.localeCompare(a.startDate) || b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, limit)
      .map((r) => this.own(r));
  }

  async findOwn(companyId: string, userId: string, id: string) {
    const row = await this.find(companyId, id);
    return row && row.userId === userId ? this.own(row) : undefined;
  }

  async medianDecisionHours(q: { companyId: string; approverIds: readonly string[]; since: Date; minSamples: number }) {
    if (q.approverIds.length === 0) return [];
    const decided = [...this.rows.values()].filter(
      (r) =>
        r.companyId === q.companyId &&
        r.approverId !== null &&
        q.approverIds.includes(r.approverId) &&
        (r.status === "approved" || r.status === "rejected") &&
        r.decidedAt !== null &&
        r.decidedAt >= q.since &&
        r.userId !== r.approverId,
    );
    const byApprover = Map.groupBy(decided, (r) => r.approverId as string);
    return [...byApprover]
      .filter(([, rs]) => rs.length >= q.minSamples)
      .map(([approverId, rs]) => ({ approverId, hours: median(rs.map((r) => ((r.decidedAt as Date).getTime() - r.createdAt.getTime()) / 3_600_000)) }));
  }

  async pageForApi(q: ApiLeaveRequestPage): Promise<ApiLeaveRequest[]> {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.companyId === q.companyId &&
          (!q.to || r.startDate <= q.to) &&
          (!q.from || r.endDate >= q.from) &&
          (!q.userId || r.userId === q.userId) &&
          (!q.status || r.status === q.status) &&
          (!q.after || r.startDate > q.after.startDate || (r.startDate === q.after.startDate && r.id > q.after.id)),
      )
      .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id))
      .slice(0, q.limit + 1)
      .map(toApi);
  }

  private own(r: LeaveRequest): OwnRequest {
    const type = this.catalog.leaveTypes[r.leaveTypeId];
    return {
      id: r.id,
      cursor: r.createdAt.toISOString(),
      startDate: r.startDate,
      endDate: r.endDate,
      dayPortion: r.dayPortion,
      days: r.days,
      status: r.status,
      note: r.note,
      decisionNote: r.decisionNote,
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
      leaveTypeName: type?.name ?? "",
      leaveTypeColor: type?.color ?? "",
      approverId: r.approverId,
      approverName: r.approverId ? (this.catalog.people[r.approverId]?.name ?? null) : null,
    };
  }
}
