import "server-only";
/**
 * The one-time TimeOff.Management import: writes an {@link ImportPlan} into one company,
 * proves every balance against TimeOff's, and commits only when they match.
 *
 * Everything runs in **one transaction**. A dry run (the default) does all of it,
 * including the reconciliation through the real balance code, then rolls back, so
 * what a dry run reports is exactly what `--apply` would commit. `--apply` commits
 * only when every person's balance for the current year equals TimeOff's (or the
 * caller passes `acceptMismatch`); otherwise it rolls back too.
 *
 * Safety rules:
 *
 * - **Once per file, once per company.** An applied import records an `import_runs`
 *   row keyed by the file's SHA-256 (unique). The same file is refused afterwards, and
 *   so is any TimeOff import into a company that already has one, `force` or not: a
 *   new export has a new hash, and importing it would insert every leave again.
 * - **Into an empty company.** A company that already has leave requests, or members
 *   other than active admins (the seed's), is refused unless `force`.
 * - **Invite-only stays intact.** People are created as rows only: no session, account
 *   link, verification token or email. Active people sign in later through the normal
 *   magic link; inactive ones cannot. An email that belongs to another company is left
 *   out and reported. The import must leave the company with an active admin.
 * - **Approvals follow OOOhm's rule.** Imported pending requests are routed as OOOhm
 *   would route them now (the requester's manager, else their department's manager, else an admin), not to TimeOff's
 *   stored approver, which stays in the audit row; decided requests keep their decider.
 * - **Audited, announced once.** Every imported row writes an `audit_log` row
 *   (`import.*` actions, `after.source: "import:timeoff"`) in the transaction.
 *   Historical leave is not replayed to webhooks: the import writes one outbox event,
 *   `import.completed`, with counts and the file hash only. That includes the rollover
 *   step's carry corrections, which are audited as `import.allowance` without the
 *   rollover's usual `balance.adjusted` events.
 * - **A person's change.** Somebody starts an import, so every audit row and the event
 *   name that admin, through the import: `byUser(<admin>, "timeoff_import")`. The caller
 *   names them by email (`actorEmail`, the CLI's `--actor`); it is resolved after people
 *   are imported, so with `--create-company` it can be one of TimeOff's admins, and it
 *   must be an active admin of the target company, or the whole import rolls back.
 *
 * Called by `scripts/import-timeoff.mts` only, with database credentials and no
 * session, like the migrate and seed scripts: the `--actor` check stands in for the
 * session an admin action would have.
 */
import type { Transaction } from "@/db/types";
import { DomainError } from "@/domain/errors";
import type { ServiceContext } from "@/server/context";
import { findAccountsByEmail, insertAuditEntries } from "@/modules/import/infrastructure/drizzle-import.repository";
import { selectTimeOffCompany } from "@/modules/import/domain/timeoff/plan/rules";
import type { TimeOffImportInput, TimeOffImportReport } from "./report";
import { applyAllowances, applyRequests } from "@/modules/import/application/steps/apply-leave";
import { applyCompanySettings, applyDepartments, applyHolidays, applyLeaveTypes } from "@/modules/import/application/steps/apply-organisation";
import { applyPeople, importActorSource } from "@/modules/import/application/steps/apply-people";
import { commitRun, importReport } from "@/modules/import/application/steps/finish";
import { assertKeepsAnActiveAdmin, matchPeople } from "@/modules/import/application/steps/match-people";
import { applyRecarry, reconcile } from "@/modules/import/application/steps/reconcile";
import { actorEmailOf } from "@/modules/import/application/steps/run";
import { refuseRepeatedFile, resolveTarget, startRun } from "@/modules/import/application/steps/target";

/** Carries the finished report out of a transaction that must roll back. */
class RollBack extends Error {
  constructor(readonly report: TimeOffImportReport) {
    super("rollback");
  }
}

/**
 * Runs the import (see the module comment).
 *
 * @returns The report, for a dry run, an applied import, or an `apply` rolled back over
 *   a balance mismatch.
 * @throws DomainError `import_refused` when the file was imported before, the company
 *   already holds a TimeOff import (even with `force`), the company is unknown or not
 *   empty (without `force`), the plan refuses (several companies or pool types), no
 *   active admin would remain, or `actorEmail` is not an active admin of the company
 *   after people are imported.
 * @throws DomainError `invalid_input` when `actorEmail` is not an email address.
 */
export async function importTimeOff(ctx: ServiceContext, input: TimeOffImportInput): Promise<TimeOffImportReport> {
  if (!/^[0-9a-f]{64}$/.test(input.source.sha256)) throw new DomainError("invalid_input", "The source hash must be SHA-256 hex.");
  // Before any work: a typo here should not cost a whole dry run.
  actorEmailOf(input.actorEmail);
  try {
    return await ctx.db.transaction(async (tx) => {
      const report = await runImport(ctx, tx, input);
      if (report.outcome !== "applied") throw new RollBack(report);
      return report;
    });
  } catch (err) {
    if (err instanceof RollBack) return err.report;
    throw err;
  }
}

/**
 * The import, step by step: plan it for the target company, then write the company's
 * settings, departments, leave types, holidays and people; name the admin running it;
 * write allowances and requests and their audit rows; run the rollover's carry; check
 * the balances; and, when applied, record the run.
 */
async function runImport(ctx: ServiceContext, tx: Transaction, input: TimeOffImportInput): Promise<TimeOffImportReport> {
  await refuseRepeatedFile(tx, input.source.sha256);
  const timeoffCompany = selectTimeOffCompany(input.snapshot, input.timeoffCompanyId);
  const run = await startRun(ctx, tx, input, timeoffCompany, await resolveTarget(tx, input, timeoffCompany));

  const existing = await findAccountsByEmail(tx, run.plan.people.map((p) => p.email));
  const people = matchPeople(run.plan.people, existing, run.company.id, () => ctx.ids.next());
  run.conflicts.push(...people.conflicts);
  assertKeepsAnActiveAdmin(people, run.accounts);

  await applyCompanySettings(run);
  const departments = await applyDepartments(run);
  const types = await applyLeaveTypes(run);
  const holidays = await applyHolidays(run);
  const accountsCreated = await applyPeople(run, people, departments.departmentId);
  const source = await importActorSource(tx, run.company, input.actorEmail);
  const allowances = await applyAllowances(run, people, types.poolRow);
  const requests = await applyRequests(run, people, types.typeIdOf);
  await insertAuditEntries(tx, source, run.audit);

  const recarried = await applyRecarry(run, people, types.poolRow, allowances, source);
  const reconciliation = await reconcile(run, people, types.poolRow, recarried);
  const writes = { departmentsCreated: departments.created, leaveTypes: types.counts, holidaysCreated: holidays.length, accountsCreated, allowances, requests, poolRow: types.poolRow };
  const report = importReport(run, people, writes, reconciliation, source);
  if (report.outcome !== "applied") return report;
  return commitRun(run, people, report, source, holidays.length);
}
