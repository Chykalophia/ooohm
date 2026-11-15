import "server-only";
import { type LeaveTypeSettingsDTO as LeaveTypeRow } from "@/modules/organisation";
/**
 * Import steps: the pool type's allowances, and leave requests.
 */
import { loadApprovalContexts, ManagerApprovalRule, reassignApprover } from "@/modules/approvals";
import { IMPORT_AUDIT_ACTIONS } from "@/shared/kernel/events";
import { listAllowancesOf, insertImportedRequests, type NewImportedRequest, upsertAllowances } from "@/modules/import/infrastructure/drizzle-import.repository";
import { findMembers } from "@/shared/lib/db/members";
import type { PlannedAllowance, PlannedRequest } from "@/modules/import/domain/timeoff/plan/types";
import type { MatchedPeople } from "./match-people";
import { allowanceSnapshot, entry, type ImportRun } from "./run";

/** The plan's allowances of the people imported. */
export const allowancesToImport = (run: Pick<ImportRun, "plan">, m: Pick<MatchedPeople, "excluded">) => run.plan.allowances.filter((a) => !m.excluded.has(a.personKey));

/** The allowance rows to write for the pool type. */
export function allowanceRows(planned: readonly PlannedAllowance[], idOf: ReadonlyMap<number, string>, poolTypeId: string) {
  return planned.map((a) => ({
    userId: idOf.get(a.personKey)!,
    leaveTypeId: poolTypeId,
    year: a.year,
    days: a.days,
    carriedOverDays: a.carriedOverDays,
    adjustmentDays: a.adjustmentDays,
  }));
}

/** Writes the pool type's allowance rows (over existing ones), each audited with what it replaced. @returns The allowances imported. */
export async function applyAllowances(run: ImportRun, m: MatchedPeople, poolRow: LeaveTypeRow | null): Promise<PlannedAllowance[]> {
  const planned = allowancesToImport(run, m);
  if (!poolRow || planned.length === 0) return planned;
  const companyMembers = [...m.existingByEmail.values()].filter((a) => a.companyId === run.company.id).map((a) => a.id);
  const before = new Map((await listAllowancesOf(run.tx, companyMembers, poolRow.id)).map((r) => [`${r.userId}|${r.year}`, r]));
  const written = await upsertAllowances(run.tx, allowanceRows(planned, m.idOf, poolRow.id));
  const byKey = new Map(planned.map((a) => [`${m.idOf.get(a.personKey)}|${a.year}`, a]));
  for (const row of written) {
    const prior = before.get(`${row.userId}|${row.year}`);
    const source = byKey.get(`${row.userId}|${row.year}`)!;
    run.audit.push(
      entry(run.company.id, IMPORT_AUDIT_ACTIONS.allowance, "allowance", row.id, row.userId, prior ? allowanceSnapshot(prior) : null, {
        ...allowanceSnapshot(row),
        timeoffAdjustment: source.timeoffAdjustment,
        employmentAdjustment: source.employmentAdjustment,
      }),
    );
  }
  return planned;
}

export interface ImportedRequest {
  request: NewImportedRequest;
  split: PlannedRequest["split"];
  plan: PlannedRequest;
  timeoffApproverId: string | null;
}

/**
 * The request rows to write. Pending requests go to `pendingApprover` (whoever OOOhm's
 * approval rule picks in the imported org); decided ones keep TimeOff's decider. A
 * request is dated from TimeOff, never "now": submit's rate limit counts requests
 * created in the last minutes.
 */
export function requestRows(
  planned: readonly PlannedRequest[],
  c: { companyId: string; idOf: ReadonlyMap<number, string>; typeIdOf: ReadonlyMap<string, string>; pendingApprover: ReadonlyMap<string, string | null>; newId: () => string },
): ImportedRequest[] {
  return planned.map((r) => {
    const createdAt = new Date(r.createdAt ?? r.decidedAt ?? `${r.startDate}T00:00:00.000Z`);
    const userId = c.idOf.get(r.personKey)!;
    const timeoffApproverId = r.approverKey !== null ? (c.idOf.get(r.approverKey) ?? null) : null;
    const request: NewImportedRequest = {
      id: c.newId(),
      companyId: c.companyId,
      userId,
      leaveTypeId: c.typeIdOf.get(r.leaveTypeKey)!,
      startDate: r.startDate,
      endDate: r.endDate,
      dayPortion: r.dayPortion,
      days: r.days,
      note: r.note,
      status: r.status,
      approverId: r.status === "pending" ? (c.pendingApprover.get(userId) ?? null) : timeoffApproverId,
      decidedAt: r.status === "pending" ? null : r.decidedAt ? new Date(r.decidedAt) : createdAt,
      decisionNote: r.decisionNote,
      createdAt,
      updatedAt: createdAt,
    };
    return { request, split: r.split, plan: r, timeoffApproverId };
  });
}

/** What a request's audit row keeps; TimeOff's approver only when OOOhm routed it elsewhere. */
export function requestAuditAfter({ request, plan: r, timeoffApproverId }: ImportedRequest) {
  return {
    status: request.status,
    leaveTypeId: request.leaveTypeId,
    startDate: request.startDate,
    endDate: request.endDate,
    dayPortion: request.dayPortion,
    days: request.days,
    approverId: request.approverId,
    timeoffApproverId: timeoffApproverId !== request.approverId ? timeoffApproverId : undefined,
    decidedAt: request.decidedAt?.toISOString() ?? null,
    timeoffLeaveId: r.timeoffLeaveId,
    part: r.parts > 1 ? `${r.part} of ${r.parts}` : undefined,
  };
}

/** Each pending requester's approver under OOOhm's rule (the manager, else their department's manager, else an admin). */
async function pendingApprovers(run: ImportRun, requesterIds: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (requesterIds.length === 0) return out;
  const requesters = await findMembers(run.tx, run.company.id, [...requesterIds]);
  const contexts = await loadApprovalContexts(run.tx, run.company.id, requesters);
  const rule = new ManagerApprovalRule();
  for (const [requesterId, context] of contexts) out.set(requesterId, reassignApprover(rule, context));
  return out;
}

/** Writes the requests of the people imported. @returns The rows written. */
export async function applyRequests(run: ImportRun, m: MatchedPeople, typeIdOf: ReadonlyMap<string, string>): Promise<ImportedRequest[]> {
  const planned = run.plan.requests.filter((r) => !m.excluded.has(r.personKey));
  const pendingRequesters = [...new Set(planned.filter((r) => r.status === "pending").map((r) => m.idOf.get(r.personKey)!))];
  const pendingApprover = await pendingApprovers(run, pendingRequesters);
  const rows = requestRows(planned, { companyId: run.company.id, idOf: m.idOf, typeIdOf, pendingApprover, newId: () => run.ctx.ids.next() });
  await insertImportedRequests(run.tx, rows);
  for (const row of rows) {
    run.audit.push(entry(run.company.id, IMPORT_AUDIT_ACTIONS.leaveRequest, "leave_request", row.request.id, row.request.userId, null, requestAuditAfter(row)));
  }
  return rows;
}
