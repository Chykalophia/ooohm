import "server-only";
/** The rows of a person's records export: their requests, balances and audit entries, one CSV. */
import type { Executor } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { log } from "@/lib/log";
import type { ServiceContext } from "@/server/context";
import { listAuditEntriesAbout } from "@/modules/audit";
import { loadBalances } from "@/modules/balances";
import { listRecordYears, listRequestsForExport } from "@/modules/people/infrastructure/drizzle-person-deletion.repository";
import { listLeaveTypesWithAllowance } from "@/server/repositories/leave-type-allowances";
import type { CsvCell } from "@/shared/kernel/csv";
import { personLabel } from "@/shared/kernel/person-label";

export const EXPORT_HEADER = [
  "record",
  "id",
  "date",
  "leave_type",
  "start_date",
  "end_date",
  "part_of_day",
  "days",
  "status",
  "note",
  "approver",
  "decided_at",
  "decision_note",
  "year",
  "allowance",
  "carried_over",
  "adjustment",
  "total",
  "used",
  "pending",
  "carried_out",
  "remaining",
  "action",
  "by",
  "changes",
] as const;

export type ExportRow = Partial<Record<(typeof EXPORT_HEADER)[number], CsvCell>>;

/** Most audit entries the export holds; a person with more gets the newest ones. */
const EXPORT_AUDIT_MAX = 10_000;

/** Their leave requests, with notes and who decided them. */
export async function requestRows(ex: Executor, companyId: string, userId: string): Promise<ExportRow[]> {
  return (await listRequestsForExport(ex, companyId, userId)).map((r) => ({
    record: "leave_request",
    id: r.id,
    date: r.createdAt.toISOString(),
    leave_type: r.leaveTypeName,
    start_date: r.startDate,
    end_date: r.endDate,
    part_of_day: r.dayPortion,
    days: r.days,
    status: r.status,
    note: r.note,
    approver: r.approverName === null ? null : personLabel({ name: r.approverName, email: r.approverEmail ?? "" }),
    decided_at: r.decidedAt?.toISOString() ?? null,
    decision_note: r.decisionNote,
  }));
}

/**
 * Their balance per leave type for every year they have an allowance or booked leave
 * (types with nothing allotted and nothing booked left out); none, logged, when the
 * company's allowance policy is unknown.
 */
export async function balanceRows(ex: Executor, company: { id: string; allowancePolicy: string }, userId: string): Promise<ExportRow[]> {
  const [years, types] = await Promise.all([listRecordYears(ex, company.id, userId), listLeaveTypesWithAllowance(ex, company.id)]);
  if (years.length === 0 || types.length === 0) return [];
  const balanceOf = await loadBalances(ex, { companyId: company.id, allowancePolicy: company.allowancePolicy, leaveTypes: types, userIds: [userId], years }).catch(
    (err: unknown) => {
      log.error({ err, companyId: company.id }, "allowance_policy_unavailable");
      return null;
    },
  );
  if (!balanceOf) return [];
  return years.flatMap((year) =>
    types.flatMap((type): ExportRow[] => {
      const b = balanceOf(userId, type.id, year);
      if (b.used === 0 && b.pending === 0 && (!b.tracked || (b.allowance === 0 && b.carriedOver === 0 && b.adjustment === 0))) return [];
      const amounts = b.tracked
        ? { allowance: b.allowance, carried_over: b.carriedOver, adjustment: b.adjustment, total: b.total, carried_out: b.carriedOut, remaining: b.remaining }
        : { allowance: "unlimited" };
      return [{ record: "balance", leave_type: type.name, year, used: b.used, pending: b.pending, ...amounts }];
    }),
  );
}

/** The audit entries about them, newest first, as the audit log names them. */
export async function auditRows(ctx: ServiceContext, actor: Actor, userId: string): Promise<ExportRow[]> {
  return (await listAuditEntriesAbout(ctx, actor, userId, EXPORT_AUDIT_MAX)).map((e) => ({
    record: "audit",
    id: e.id,
    date: e.at.toISOString(),
    action: e.label,
    by: e.actorLabel,
    changes: e.changes.join("; "),
  }));
}
