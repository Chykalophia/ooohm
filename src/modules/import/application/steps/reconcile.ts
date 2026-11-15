import "server-only";
import { type LeaveTypeSettingsDTO as LeaveTypeRow } from "@/modules/organisation";
/**
 * Import steps: the year rollover's carry for the imported year, and the balance check
 * against TimeOff.
 */
import type { Transaction } from "@/db/types";
import { addDays } from "@/shared/kernel/day-amounts";
import { type Balance, loadBalances, recarryMemberLeaveType, resolveAllowancePolicy } from "@/modules/balances";
import type { UserChangeSource } from "@/domain/change-source";
import { IMPORT_AUDIT_ACTIONS } from "@/domain/events";
import { insertAuditEntries, listAllowancesOf } from "@/server/repositories/imports";
import { lockMember } from "@/shared/lib/db/members";
import type { AuditEntry } from "@/shared/lib/db/change-log";
import type { ExpectedBalance, ImportPlan, PlannedAllowance } from "@/modules/import/domain/timeoff/plan/types";
import type { Reconciliation, ReconciliationMismatch, ReconciliationRow } from "@/modules/import/application/report";
import { activeAfterImport, type MatchedPeople } from "./match-people";
import { allowanceSnapshot, type AllowanceSnapshotInput, entry, type ImportRun } from "./run";

/** Per person: the carry-over the import wrote for the current year, and what the rollover made of it. */
export type Recarried = Map<string, { before: number; after: number }>;

/**
 * Runs what the nightly year rollover will do to last year's carry, for every active
 * person the import gave a current-year allowance. Audited like every imported row, and
 * attributed the same way (the import caused the carry, so it is the import's change,
 * not the nightly process's), without the rollover's `balance.adjusted` events: the
 * import announces itself with `import.completed` only.
 */
export async function applyRecarry(run: ImportRun, m: MatchedPeople, poolRow: LeaveTypeRow | null, allowances: readonly PlannedAllowance[], source: UserChangeSource): Promise<Recarried> {
  const recarried: Recarried = new Map();
  if (!poolRow) return recarried;
  const audit: AuditEntry[] = [];
  const record = async (_tx: Transaction, change: { reason: string; before: AllowanceSnapshotInput | null; after: AllowanceSnapshotInput & { id: string } }) => {
    audit.push(
      entry(run.company.id, IMPORT_AUDIT_ACTIONS.allowance, "allowance", change.after.id, change.after.userId, change.before ? allowanceSnapshot(change.before) : null, {
        ...allowanceSnapshot(change.after),
        reason: change.reason,
      }),
    );
  };
  const policy = resolveAllowancePolicy(run.company.allowancePolicy);
  const imported = new Map(allowances.filter((a) => a.year === run.currentYear).map((a) => [m.idOf.get(a.personKey)!, a.carriedOverDays]));
  for (const p of m.people.filter((x) => activeAfterImport(m, x) && imported.has(m.idOf.get(x.key)!))) {
    const member = await lockMember(run.tx, run.company.id, m.idOf.get(p.key)!);
    if (!member) continue;
    const job = { companyId: run.company.id, timezone: run.company.timezone, policy, member, leaveType: poolRow, closingYear: run.currentYear - 1, source, record };
    const { carried } = await recarryMemberLeaveType(run.tx, job);
    if (carried > 0) recarried.set(member.id, { before: imported.get(member.id)!, after: Number.NaN });
  }
  if (recarried.size > 0) {
    const rows = await listAllowancesOf(run.tx, [...recarried.keys()], poolRow.id);
    for (const r of rows.filter((x) => x.year === run.currentYear)) recarried.get(r.userId)!.after = r.carriedOverDays;
  }
  await insertAuditEntries(run.tx, source, audit);
  return recarried;
}

/** The two sides of one expected balance. OOOhm's is put on TimeOff's footing (see {@link ReconciliationRow.ooohm}). */
export function reconciliationRow(
  e: ExpectedBalance,
  person: { email: string; name: string },
  balance: Balance,
): ReconciliationRow {
  const ooohm = balance.tracked ? addDays(balance.remaining, balance.pending, balance.carriedOut) : null;
  return {
    email: person.email,
    name: person.name,
    year: e.year,
    timeoff: e.timeoff.remaining,
    ooohm,
    diff: ooohm === null ? null : addDays(ooohm, -e.timeoff.remaining),
    pending: balance.pending,
    detail: e.timeoff,
  };
}

/** Why a person-year differs, as far as the importer can tell. */
export function mismatchReasons(
  e: ExpectedBalance,
  row: Pick<ReconciliationRow, "ooohm">,
  c: { plan: Pick<ImportPlan, "leaveCostDifferences">; carry: { before: number; after: number } | undefined; currentYear: number },
): string[] {
  const reasons: string[] = [];
  for (const d of c.plan.leaveCostDifferences.filter((x) => x.personKey === e.personKey && x.year === e.year)) {
    reasons.push(
      d.reason === "personal_schedule"
        ? `TimeOff leave ${d.timeoffLeaveId}: ${d.timeoff} day(s) on their own TimeOff schedule, ${d.ooohm} on the company's working days.`
        : d.reason === "company_holiday"
          ? `TimeOff leave ${d.timeoffLeaveId}: TimeOff takes ${d.timeoff} day(s) in ${d.year}; OOOhm counts ${d.ooohm}, because the company already has a holiday in it that TimeOff does not.`
          : `TimeOff leave ${d.timeoffLeaveId}: TimeOff takes ${d.timeoff} day(s) in ${d.year} (its half-day rule), OOOhm counts ${d.ooohm}.`,
    );
  }
  if (c.carry && e.year === c.currentYear) {
    reasons.push(`Carried over into ${e.year}: TimeOff stored ${c.carry.before}, OOOhm's year rollover computes ${c.carry.after} from ${e.year - 1}.`);
  }
  if (e.timeoff.beforeStart) reasons.push(`TimeOff shows nothing for ${e.year}: it is before their start date.`);
  if (row.ooohm === null) reasons.push(`OOOhm has no allowance for ${e.year} (outside their employment dates in TimeOff).`);
  if (reasons.length === 0) reasons.push("No known cause; compare the TimeOff detail with the person's OOOhm allowance page.");
  return reasons;
}

const byEmailAndYear = (a: ReconciliationRow, b: ReconciliationRow) => a.email.localeCompare(b.email) || a.year - b.year;

/**
 * Compares TimeOff's balance with OOOhm's, through the same balance code the dashboard
 * uses, for every person and year the plan expects. Runs inside the import transaction,
 * after the rollover step, so it sees exactly what would be committed.
 */
export async function reconcile(run: ImportRun, m: MatchedPeople, poolRow: LeaveTypeRow | null, recarried: Recarried): Promise<Reconciliation> {
  const expected = run.plan.expected.filter((e) => !m.excluded.has(e.personKey));
  if (!poolRow || expected.length === 0) return { currentYear: run.currentYear, rows: [], mismatches: [], currentYearMismatches: 0 };
  const people = new Map(m.people.map((p) => [p.key, { id: m.idOf.get(p.key)!, email: p.email, name: p.name }]));
  const balanceOf = await loadBalances(run.tx, {
    companyId: run.company.id,
    allowancePolicy: run.company.allowancePolicy,
    leaveTypes: [poolRow],
    userIds: [...new Set(expected.map((e) => people.get(e.personKey)!.id))],
    years: [...new Set(expected.map((e) => e.year))],
  });
  const rows: ReconciliationRow[] = [];
  const mismatches: ReconciliationMismatch[] = [];
  for (const e of expected) {
    const person = people.get(e.personKey)!;
    const row = reconciliationRow(e, person, balanceOf(person.id, poolRow.id, e.year));
    rows.push(row);
    if (row.diff !== 0) mismatches.push({ ...row, reasons: mismatchReasons(e, row, { plan: run.plan, carry: recarried.get(person.id), currentYear: run.currentYear }) });
  }
  rows.sort(byEmailAndYear);
  mismatches.sort(byEmailAndYear);
  return { currentYear: run.currentYear, rows, mismatches, currentYearMismatches: mismatches.filter((x) => x.year === run.currentYear).length };
}
