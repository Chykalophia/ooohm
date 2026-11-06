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
import { randomUUID } from "node:crypto";
import type { Transaction } from "@/db/types";
import type { Role } from "@/domain/actor";
import { addDays, resolveAllowancePolicy } from "@/domain/allowance-policy";
import { ManagerApprovalRule, reassignApprover } from "@/domain/approval-rule";
import { type CalendarDate } from "@/domain/calendar-date";
import { byUser, CHANGE_PROCESSES, type UserChangeSource } from "@/domain/change-source";
import { COMPANY_NAME_MAX_LENGTH } from "@/domain/company-settings";
import { DomainError } from "@/domain/errors";
import { IMPORT_AUDIT_ACTIONS, IMPORT_EVENT_TYPES, type ImportCompletedPayload, type Unattributed } from "@/domain/events";
import { isUuid } from "@/domain/ids";
import { normalizeEmail } from "@/domain/people";
import { oneLine } from "@/domain/text";
import type { TimeOffYearBalance } from "@/domain/timeoff/balance";
import {
  buildImportPlan,
  type ImportIssue,
  type ImportPlan,
  leaveTypeCodeFor,
  selectTimeOffCompany,
  timeOffTimeZone,
} from "@/domain/timeoff/mapping";
import type { TimeOffSnapshot } from "@/domain/timeoff/source";
import { todayInTimeZone, yearInTimeZone } from "@/lib/dates";
import type { ServiceContext } from "@/server/context";
import { type AuditEntry, recordChange } from "@/server/repositories/change-log";
import { type CompanyRow, lockCompany, updateCompany } from "@/server/repositories/companies";
import { insertDepartment } from "@/server/repositories/departments";
import { insertHolidays, listHolidayRows } from "@/server/repositories/holidays";
import {
  countCompanyLeaveRequests,
  countRequestsByLeaveType,
  type ExistingAccount,
  findAccountsByEmail,
  findImportRunByCompany,
  findImportRunBySha,
  insertAuditEntries,
  insertCompany,
  insertImportedAccounts,
  insertImportedRequests,
  insertImportRun,
  listAllowancesOf,
  listCompanyAccounts,
  listCompanyNames,
  listDepartmentsByName,
  lockCompaniesTable,
  type NewImportedRequest,
  updateImportedAccount,
  upsertAllowances,
} from "@/server/repositories/imports";
import { insertLeaveType, type LeaveTypeRow, listAllLeaveTypes, updateLeaveType } from "@/server/repositories/leave-types";
import { findMembers, lockMember } from "@/server/repositories/users";
import { loadApprovalContexts } from "./approval-routing";
import { loadBalances } from "./balances";
import { recarryMemberLeaveType } from "./rollover";

/** `audit_log.after.source` and `import_runs.source` of this importer. */
export const TIMEOFF_IMPORT_SOURCE = "timeoff";
const AUDIT_SOURCE = "import:timeoff";

export interface TimeOffImportInput {
  snapshot: TimeOffSnapshot;
  /** The source file: its SHA-256 (hex) and base name. */
  source: { sha256: string; fileName: string };
  /** An existing company, or a name for a new one. */
  target: { companyId: string } | { createCompany: string };
  /**
   * Email of the admin running the import (the CLI's `--actor`). Every change is
   * recorded as theirs, via `timeoff_import`. Must be an active admin of the target
   * company once people are imported; otherwise the import is refused.
   */
  actorEmail: string;
  /** The TimeOff company to read, when the file holds several. */
  timeoffCompanyId?: number;
  /** See {@link ImportPlanOptions.poolTypeName}. */
  poolType?: string;
  mergePoolTypes?: boolean;
  /** Commit. Without it the whole import runs and rolls back (a dry run). */
  apply?: boolean;
  /** Import into a company that already has leave requests or non-admin members. */
  force?: boolean;
  /** Commit even when a current-year balance differs from TimeOff's. */
  acceptMismatch?: boolean;
}

/** One person's balance in one year, on both sides. */
export interface ReconciliationRow {
  email: string;
  name: string;
  year: number;
  /** TimeOff's remaining (total − approved days). */
  timeoff: number;
  /**
   * OOOhm's remaining on the same footing: total − approved days, i.e. the balance the
   * dashboard shows plus pending days and days already carried into the next year (both
   * of which OOOhm subtracts and TimeOff does not). `null` when OOOhm tracks no
   * allowance for that year.
   */
  ooohm: number | null;
  /** ooohm − timeoff; `null` when OOOhm has nothing to compare. */
  diff: number | null;
  /** OOOhm's pending days in the year (TimeOff's "new" leave), shown apart on both sides. */
  pending: number;
  /** TimeOff's figure, part by part. */
  detail: TimeOffYearBalance;
}

export interface ReconciliationMismatch extends ReconciliationRow {
  /** Why the two differ, as far as the importer can tell. */
  reasons: string[];
}

export interface ImportCounts {
  people: { created: number; updated: number; active: number; inactive: number };
  departments: { created: number; reused: number };
  leaveTypes: { created: number; updated: number; archived: number };
  holidays: { created: number; alreadyThere: number };
  allowances: number;
  leaveRequests: { total: number; pending: number; approved: number; rejected: number; cancelled: number };
  skipped: { users: number; leaves: number };
}

export interface TimeOffImportReport {
  /**
   * `dry_run`: nothing was written. `applied`: committed. `rolled_back`: `apply` was asked
   * for but a current-year balance differs, so nothing was written.
   */
  outcome: "dry_run" | "applied" | "rolled_back";
  source: { sha256: string; fileName: string };
  company: { id: string; name: string; created: boolean; timezone: string; workingDays: number[] };
  /** The admin who ran it (`--actor`), whom every change is attributed to. */
  actor: { userId: string; email: string };
  importRunId: string | null;
  poolLeaveType: { code: string; name: string; mergedFrom: string[] } | null;
  counts: ImportCounts;
  reconciliation: {
    currentYear: number;
    rows: ReconciliationRow[];
    mismatches: ReconciliationMismatch[];
    /** Mismatches in the current year: these block `apply`. */
    currentYearMismatches: number;
  };
  warnings: ImportIssue[];
  conflicts: ImportIssue[];
}

/** Carries the finished report out of a transaction that must roll back. */
class RollBack extends Error {
  constructor(readonly report: TimeOffImportReport) {
    super("rollback");
  }
}

const ROLE_RANK: Readonly<Record<Role, number>> = { employee: 0, manager: 1, admin: 2 };

function refuse(message: string): never {
  throw new DomainError("import_refused", message);
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

async function runImport(ctx: ServiceContext, tx: Transaction, input: TimeOffImportInput): Promise<TimeOffImportReport> {
  const previous = await findImportRunBySha(tx, input.source.sha256);
  if (previous) {
    refuse(`This file was already imported on ${previous.createdAt.toISOString()} (import run ${previous.id}). Importing it again would duplicate everyone's history.`);
  }

  // Target company
  const timeoffCompany = selectTimeOffCompany(input.snapshot, input.timeoffCompanyId);
  const audit: AuditEntry[] = [];
  let company: CompanyRow;
  let created = false;
  if ("companyId" in input.target) {
    const found = isUuid(input.target.companyId) ? await lockCompany(tx, input.target.companyId) : undefined;
    if (!found) {
      const known = (await listCompanyNames(tx)).map((c) => `${c.id} (${c.name})`).join(", ");
      refuse(`There is no company ${input.target.companyId}. Companies: ${known || "none"}.`);
    }
    company = found!;
    // After the lock, so two imports into one company cannot both pass this check.
    const imported = await findImportRunByCompany(tx, company.id, TIMEOFF_IMPORT_SOURCE);
    if (imported) {
      refuse(
        `Company "${company.name}" already holds a TimeOff import (${imported.sourceFileName}, ${imported.createdAt.toISOString()}, import run ${imported.id}). ` +
          `Importing another export into it would add every TimeOff leave a second time, so it is refused even with --force. ` +
          `To redo the import, restore the database backup taken before it (docs/deploy.md) and import the new export once.`,
      );
    }
  } else {
    const name = oneLine(input.target.createCompany);
    if (name.length === 0 || name.length > COMPANY_NAME_MAX_LENGTH) refuse(`Company names are 1 to ${COMPANY_NAME_MAX_LENGTH} characters.`);
    // v1 runs one company per deployment. Locked first; the seed takes the same lock
    // before its own check, so neither it nor another import can create one meanwhile.
    await lockCompaniesTable(tx);
    const existing = await listCompanyNames(tx);
    if (existing.length > 0) {
      const known = existing.map((c) => `${c.id} (${c.name})`).join(", ");
      refuse(
        `This deployment already has a company: ${known}. OOOhm runs one company per deployment, so --create-company only works on an empty database. ` +
          `Import into the existing company with --company ${existing[0].id} instead.`,
      );
    }
    company = await insertCompany(tx, { name, timezone: timeOffTimeZone(timeoffCompany) ?? "UTC", workingDays: [1, 2, 3, 4, 5] });
    created = true;
  }
  const accounts = created ? [] : await listCompanyAccounts(tx, company.id);
  if (!created && !input.force) {
    const requests = await countCompanyLeaveRequests(tx, company.id);
    const others = accounts.filter((a) => !(a.role === "admin" && a.isActive));
    if (requests > 0 || others.length > 0) {
      refuse(
        `Company "${company.name}" already has ${requests} leave request(s) and ${others.length} member(s) besides its active admins. ` +
          `The import expects a freshly seeded company. Pass --force to import into it anyway: people with the same email are updated, not duplicated, ` +
          `and all of TimeOff's leave history is added next to the requests already there.`,
      );
    }
  }

  const timezone = timeOffTimeZone(timeoffCompany) ?? company.timezone;
  const today: CalendarDate = todayInTimeZone(timezone, ctx.now());
  const currentYear = yearInTimeZone(timezone, ctx.now());
  const existingHolidays = created ? [] : await listHolidayRows(tx, company.id, "0001-01-01", "9999-12-31");
  const plan = buildImportPlan(input.snapshot, {
    timeoffCompanyId: timeoffCompany.id,
    poolTypeName: input.poolType,
    mergePoolTypes: input.mergePoolTypes,
    currentYear,
    today,
    existingHolidays: new Set(existingHolidays.map((h) => h.date)),
  });
  const warnings = [...plan.warnings];
  const conflicts = [...plan.conflicts];

  // People: who is imported, who already exists
  const existingByEmail = new Map((await findAccountsByEmail(tx, plan.people.map((p) => p.email))).map((a) => [a.email, a]));
  const excluded = new Set<number>();
  for (const p of plan.people) {
    const existing = existingByEmail.get(p.email);
    if (existing && existing.companyId !== company.id) {
      excluded.add(p.key);
      conflicts.push({ code: "email_in_other_company", email: p.email, timeoffId: p.key, message: `${p.email} already has an account in another company; not imported, nor their leave.` });
    }
  }
  const people = plan.people.filter((p) => !excluded.has(p.key));
  const idOf = new Map<number, string>(people.map((p) => [p.key, existingByEmail.get(p.email)?.id ?? randomUUID()]));
  const roleOf = (p: (typeof people)[number]) => {
    const existing = existingByEmail.get(p.email);
    return existing && ROLE_RANK[existing.role] > ROLE_RANK[p.role] ? existing.role : p.role;
  };
  const importedEmails = new Set(people.map((p) => p.email));
  const activeAdmins =
    people.filter((p) => roleOf(p) === "admin" && (existingByEmail.get(p.email)?.isActive ?? p.isActive)).length +
    accounts.filter((a) => a.role === "admin" && a.isActive && !importedEmails.has(a.email)).length;
  if (activeAdmins === 0) {
    refuse("After the import the company would have no active admin, so nobody could manage it. Make someone an admin in TimeOff, or seed an admin first (SEED_ADMIN_EMAIL).");
  }

  // Company settings
  const settings = { name: company.name, timezone, workingDays: plan.company.workingDays, allowancePolicy: company.allowancePolicy };
  if (created || settings.timezone !== company.timezone || settings.workingDays.join() !== company.workingDays.join()) {
    const before = created ? null : { name: company.name, timezone: company.timezone, workingDays: company.workingDays };
    company = await updateCompany(tx, company.id, settings);
    audit.push(
      entry(company.id, IMPORT_AUDIT_ACTIONS.company, "company", company.id, null, before, {
        name: company.name,
        timezone: company.timezone,
        workingDays: company.workingDays,
        timeoffCompanyId: timeoffCompany.id,
      }),
    );
  }

  // Departments
  const departmentsByName = await listDepartmentsByName(tx, company.id);
  const departmentId = new Map<number, string>();
  let departmentsCreated = 0;
  for (const d of plan.departments) {
    const existing = departmentsByName.get(d.name.toLowerCase());
    if (existing) {
      departmentId.set(d.key, existing.id);
      continue;
    }
    const row = await insertDepartment(tx, { companyId: company.id, name: d.name });
    departmentId.set(d.key, row.id);
    departmentsCreated++;
    audit.push(entry(company.id, IMPORT_AUDIT_ACTIONS.department, "department", row.id, null, null, { name: row.name, timeoffDepartmentId: d.key }));
  }

  // Leave types
  const existingTypes = await listAllLeaveTypes(tx, company.id);
  const usedTypeIds = new Set<string>();
  const takenCodes = new Set(existingTypes.map((t) => t.code));
  const typeIdOf = new Map<string, string>();
  let poolRow: LeaveTypeRow | null = null;
  const typeCounts = { created: 0, updated: 0, archived: 0 };
  for (const t of plan.leaveTypes) {
    const settingsOf = {
      countsAgainstAllowance: t.countsAgainstAllowance,
      defaultAllowanceDays: t.defaultAllowanceDays,
      carryoverEnabled: t.carryoverEnabled,
      carryoverMaxDays: t.carryoverMaxDays,
      // TimeOff's order, so the pool type leads the request form (its first type is the default).
      sortOrder: t.sortOrder,
    };
    const match = existingTypes.find(
      (e) => !usedTypeIds.has(e.id) && (e.code === t.key || e.name.trim().toLowerCase() === t.name.toLowerCase()),
    );
    let row: LeaveTypeRow;
    if (match) {
      usedTypeIds.add(match.id);
      row = await updateLeaveType(tx, company.id, match.id, { ...settingsOf, archivedAt: null });
      typeCounts.updated++;
      audit.push(entry(company.id, IMPORT_AUDIT_ACTIONS.leaveType, "leave_type", row.id, null, leaveTypeSnapshot(match), {
        ...leaveTypeSnapshot(row),
        timeoffLeaveTypeIds: t.timeoffTypeIds,
      }));
    } else {
      const code = takenCodes.has(t.key) ? leaveTypeCodeFor(t.name, takenCodes) : t.key;
      takenCodes.add(code);
      row = await insertLeaveType(tx, { companyId: company.id, code, name: t.name, color: t.color, isPaid: true, ...settingsOf });
      usedTypeIds.add(row.id);
      typeCounts.created++;
      audit.push(entry(company.id, IMPORT_AUDIT_ACTIONS.leaveType, "leave_type", row.id, null, null, { ...leaveTypeSnapshot(row), timeoffLeaveTypeIds: t.timeoffTypeIds }));
    }
    typeIdOf.set(t.key, row.id);
    if (t.pool) poolRow = row;
  }
  const requestsByType = await countRequestsByLeaveType(tx, company.id);
  let nextSortOrder = plan.leaveTypes.length;
  for (const e of existingTypes.filter((x) => !usedTypeIds.has(x.id) && x.archivedAt === null)) {
    if ((requestsByType.get(e.id) ?? 0) > 0) {
      await updateLeaveType(tx, company.id, e.id, { sortOrder: nextSortOrder++ });
      warnings.push({ code: "leave_type_kept", message: `Leave type "${e.name}" is not in TimeOff but has requests; left active, after the imported types.` });
      continue;
    }
    const row = await updateLeaveType(tx, company.id, e.id, { archivedAt: ctx.now() });
    typeCounts.archived++;
    audit.push(entry(company.id, IMPORT_AUDIT_ACTIONS.leaveType, "leave_type", row.id, null, leaveTypeSnapshot(e), leaveTypeSnapshot(row)));
  }

  // Holidays
  const holidayRows = await insertHolidays(
    tx,
    company.id,
    plan.holidays.map((h) => ({ date: h.date, name: h.name })),
  );
  for (const h of holidayRows) {
    audit.push(entry(company.id, IMPORT_AUDIT_ACTIONS.holiday, "holiday", h.id, null, null, { date: h.date, name: h.name }));
  }

  // People
  const newAccounts = people.filter((p) => !existingByEmail.has(p.email));
  await insertImportedAccounts(
    tx,
    newAccounts.map((p) => ({
      id: idOf.get(p.key)!,
      companyId: company.id,
      email: p.email,
      name: p.name,
      role: p.role,
      departmentId: p.departmentKey !== null ? (departmentId.get(p.departmentKey) ?? null) : null,
      canSelfApprove: p.canSelfApprove,
      isActive: p.isActive,
      createdAt: new Date(p.createdAt),
    })),
  );
  for (const p of people) {
    const existing = existingByEmail.get(p.email);
    const managerId = p.managerKey !== null ? (idOf.get(p.managerKey) ?? null) : null;
    const after = {
      name: p.name,
      role: roleOf(p),
      departmentId: p.departmentKey !== null ? (departmentId.get(p.departmentKey) ?? null) : null,
      managerId,
      canSelfApprove: p.canSelfApprove || (existing?.canSelfApprove ?? false),
    };
    if (existing || managerId !== null) await updateImportedAccount(tx, company.id, idOf.get(p.key)!, existing ? after : { managerId });
    audit.push(
      entry(company.id, IMPORT_AUDIT_ACTIONS.user, "user", idOf.get(p.key)!, idOf.get(p.key)!, existing ? accountSnapshot(existing) : null, {
        ...after,
        email: p.email,
        isActive: existing?.isActive ?? p.isActive,
        timeoffUserId: p.key,
      }),
    );
  }

  // Who is running it
  // After people are imported, so a new company's TimeOff admin can be named; nothing
  // has been audited yet, and a refusal rolls everything back.
  const source = await importActorSource(tx, company, input.actorEmail);

  // Allowances
  const allowancePlan = plan.allowances.filter((a) => !excluded.has(a.personKey));
  if (poolRow && allowancePlan.length > 0) {
    const before = new Map(
      (await listAllowancesOf(tx, [...existingByEmail.values()].filter((a) => a.companyId === company.id).map((a) => a.id), poolRow.id)).map((r) => [
        `${r.userId}|${r.year}`,
        r,
      ]),
    );
    const written = await upsertAllowances(
      tx,
      allowancePlan.map((a) => ({
        userId: idOf.get(a.personKey)!,
        leaveTypeId: poolRow!.id,
        year: a.year,
        days: a.days,
        carriedOverDays: a.carriedOverDays,
        adjustmentDays: a.adjustmentDays,
      })),
    );
    const planned = new Map(allowancePlan.map((a) => [`${idOf.get(a.personKey)}|${a.year}`, a]));
    for (const row of written) {
      const prior = before.get(`${row.userId}|${row.year}`);
      const source = planned.get(`${row.userId}|${row.year}`)!;
      audit.push(
        entry(company.id, IMPORT_AUDIT_ACTIONS.allowance, "allowance", row.id, row.userId, prior ? allowanceSnapshot(prior) : null, {
          ...allowanceSnapshot(row),
          timeoffAdjustment: source.timeoffAdjustment,
          employmentAdjustment: source.employmentAdjustment,
        }),
      );
    }
  }

  // Leave requests
  const requestPlan = plan.requests.filter((r) => !excluded.has(r.personKey));
  // Pending requests go to whoever OOOhm's approval rule picks in the imported org (the
  // manager, else their department's manager, else an admin), not TimeOff's stored approver; decided ones keep TimeOff's decider.
  const pendingApprover = new Map<string, string | null>();
  const pendingRequesters = [...new Set(requestPlan.filter((r) => r.status === "pending").map((r) => idOf.get(r.personKey)!))];
  if (pendingRequesters.length > 0) {
    const requesters = await findMembers(tx, company.id, pendingRequesters);
    const contexts = await loadApprovalContexts(tx, company.id, requesters);
    const rule = new ManagerApprovalRule();
    for (const [requesterId, context] of contexts) pendingApprover.set(requesterId, reassignApprover(rule, context));
  }
  const requestRows = requestPlan.map((r) => {
    // Never "now" for history: submit's rate limit counts requests created in the last minutes.
    const createdAt = new Date(r.createdAt ?? r.decidedAt ?? `${r.startDate}T00:00:00.000Z`);
    const userId = idOf.get(r.personKey)!;
    const timeoffApproverId = r.approverKey !== null ? (idOf.get(r.approverKey) ?? null) : null;
    const request: NewImportedRequest = {
      id: randomUUID(),
      companyId: company.id,
      userId,
      leaveTypeId: typeIdOf.get(r.leaveTypeKey)!,
      startDate: r.startDate,
      endDate: r.endDate,
      dayPortion: r.dayPortion,
      days: r.days,
      note: r.note,
      status: r.status,
      approverId: r.status === "pending" ? (pendingApprover.get(userId) ?? null) : timeoffApproverId,
      decidedAt: r.status === "pending" ? null : r.decidedAt ? new Date(r.decidedAt) : createdAt,
      decisionNote: r.decisionNote,
      createdAt,
      updatedAt: createdAt,
    };
    return { request, split: r.split, plan: r, timeoffApproverId };
  });
  await insertImportedRequests(tx, requestRows);
  for (const { request, plan: r, timeoffApproverId } of requestRows) {
    audit.push(
      entry(company.id, IMPORT_AUDIT_ACTIONS.leaveRequest, "leave_request", request.id, request.userId, null, {
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
      }),
    );
  }
  await insertAuditEntries(tx, source, audit);

  // What the nightly year rollover will do to last year's carry
  // Audited like every imported row, and attributed the same way (the import caused the
  // carry, so it is the import's change, not the nightly process's), without the
  // rollover's `balance.adjusted` events: the import announces itself with
  // `import.completed` only.
  const recarried = new Map<string, { before: number; after: number }>();
  const recarryAudit: AuditEntry[] = [];
  const recordRecarry = async (_tx: Transaction, change: { reason: string; before: AllowanceSnapshotInput | null; after: AllowanceSnapshotInput & { id: string } }) => {
    recarryAudit.push(
      entry(company.id, IMPORT_AUDIT_ACTIONS.allowance, "allowance", change.after.id, change.after.userId, change.before ? allowanceSnapshot(change.before) : null, {
        ...allowanceSnapshot(change.after),
        reason: change.reason,
      }),
    );
  };
  if (poolRow) {
    const policy = resolveAllowancePolicy(company.allowancePolicy);
    const imported = new Map(allowancePlan.filter((a) => a.year === currentYear).map((a) => [idOf.get(a.personKey)!, a.carriedOverDays]));
    for (const p of people.filter((x) => (existingByEmail.get(x.email)?.isActive ?? x.isActive) && imported.has(idOf.get(x.key)!))) {
      const member = await lockMember(tx, company.id, idOf.get(p.key)!);
      if (!member) continue;
      const { carried } = await recarryMemberLeaveType(tx, {
        companyId: company.id,
        timezone: company.timezone,
        policy,
        member,
        leaveType: poolRow,
        closingYear: currentYear - 1,
        source,
        record: recordRecarry,
      });
      if (carried > 0) recarried.set(member.id, { before: imported.get(member.id)!, after: Number.NaN });
    }
    if (recarried.size > 0) {
      const rows = await listAllowancesOf(tx, [...recarried.keys()], poolRow.id);
      for (const r of rows.filter((x) => x.year === currentYear)) recarried.get(r.userId)!.after = r.carriedOverDays;
    }
    await insertAuditEntries(tx, source, recarryAudit);
  }

  // Reconciliation
  const reconciliation = await reconcile(tx, {
    plan,
    excluded,
    people: new Map(people.map((p) => [p.key, { id: idOf.get(p.key)!, email: p.email, name: p.name }])),
    poolRow,
    allowancePolicy: company.allowancePolicy,
    currentYear,
    recarried,
  });

  const counts: ImportCounts = {
    people: {
      created: newAccounts.length,
      updated: people.length - newAccounts.length,
      active: people.filter((p) => existingByEmail.get(p.email)?.isActive ?? p.isActive).length,
      inactive: people.filter((p) => !(existingByEmail.get(p.email)?.isActive ?? p.isActive)).length,
    },
    departments: { created: departmentsCreated, reused: plan.departments.length - departmentsCreated },
    leaveTypes: typeCounts,
    holidays: { created: holidayRows.length, alreadyThere: plan.holidays.length - holidayRows.length },
    allowances: poolRow ? allowancePlan.length : 0,
    leaveRequests: {
      total: requestRows.length,
      pending: requestRows.filter((r) => r.request.status === "pending").length,
      approved: requestRows.filter((r) => r.request.status === "approved").length,
      rejected: requestRows.filter((r) => r.request.status === "rejected").length,
      cancelled: requestRows.filter((r) => r.request.status === "cancelled").length,
    },
    skipped: {
      users: plan.skipped.users + excluded.size,
      leaves: plan.skipped.leaves + plan.requests.filter((r) => excluded.has(r.personKey) && r.part === 1).length,
    },
  };
  const blocked = reconciliation.currentYearMismatches > 0 && !input.acceptMismatch;
  const outcome: TimeOffImportReport["outcome"] = !input.apply ? "dry_run" : blocked ? "rolled_back" : "applied";
  const report: TimeOffImportReport = {
    outcome,
    source: input.source,
    company: { id: company.id, name: company.name, created, timezone: company.timezone, workingDays: company.workingDays },
    actor: { userId: source.userId, email: actorEmailOf(input.actorEmail) },
    importRunId: null,
    poolLeaveType: poolRow
      ? {
          code: poolRow.code,
          name: poolRow.name,
          mergedFrom: input.snapshot.leaveTypes
            .filter((t) => plan.leaveTypes.find((p) => p.pool)?.timeoffTypeIds.includes(t.id))
            .map((t) => t.name),
        }
      : null,
    counts,
    reconciliation,
    warnings,
    conflicts,
  };
  if (outcome !== "applied") return report;

  const run = await insertImportRun(tx, {
    companyId: company.id,
    source: TIMEOFF_IMPORT_SOURCE,
    sourceSha256: input.source.sha256,
    sourceFileName: input.source.fileName,
    counts,
    report: { ...report, importRunId: null },
  });
  report.importRunId = run.id;
  const payload: Unattributed<ImportCompletedPayload> = {
    importRunId: run.id,
    source: TIMEOFF_IMPORT_SOURCE,
    sourceSha256: input.source.sha256,
    counts: {
      people: people.length,
      departments: plan.departments.length,
      leaveTypes: plan.leaveTypes.length,
      holidays: holidayRows.length,
      allowances: counts.allowances,
      leaveRequests: requestRows.length,
    },
    mismatches: reconciliation.mismatches.length,
  };
  await recordChange(tx, {
    source,
    // Flat fields, so the audit viewer can show them; the full counts are in import_runs.
    audit: entry(company.id, IMPORT_AUDIT_ACTIONS.completed, "import_run", run.id, null, null, {
      fileName: input.source.fileName,
      sourceSha256: input.source.sha256,
      ...payload.counts,
      mismatches: reconciliation.mismatches.length,
      warnings: warnings.length,
      conflicts: conflicts.length,
    }),
    event: { companyId: company.id, type: IMPORT_EVENT_TYPES.completed, payload },
  });
  return report;
}

function entry(
  companyId: string,
  action: string,
  entityType: string,
  entityId: string,
  subjectUserId: string | null,
  before: unknown,
  after: object,
): AuditEntry {
  return { companyId, action, entityType, entityId, subjectUserId, before, after: { ...after, source: AUDIT_SOURCE } };
}

/** `actorEmail` as stored, or a refusal that says which flag was wrong. */
function actorEmailOf(raw: string): string {
  try {
    return normalizeEmail(raw);
  } catch {
    throw new DomainError("invalid_input", `--actor "${raw}" isn't an email address. Name the admin who is running the import.`);
  }
}

/**
 * The import's source: the admin named by `actorEmail`, through the import. Read after
 * people are imported, so it sees roles and accounts as the import leaves them.
 *
 * @throws DomainError `import_refused` unless that email is an active admin of `company`.
 */
async function importActorSource(tx: Transaction, company: CompanyRow, actorEmail: string): Promise<UserChangeSource> {
  const email = actorEmailOf(actorEmail);
  const [account] = await findAccountsByEmail(tx, [email]);
  if (!account || account.companyId !== company.id) {
    refuse(
      `--actor ${email} is not a member of company "${company.name}", nor one of the people this import brings in. ` +
        `Name an active admin of that company: the person running the import.`,
    );
  }
  if (account.role !== "admin" || !account.isActive) {
    refuse(`--actor ${email} is not an active admin of company "${company.name}". Only an active admin may run an import.`);
  }
  return byUser(account.id, CHANGE_PROCESSES.timeoffImport);
}

function leaveTypeSnapshot(t: LeaveTypeRow) {
  return {
    code: t.code,
    name: t.name,
    color: t.color,
    countsAgainstAllowance: t.countsAgainstAllowance,
    defaultAllowanceDays: t.defaultAllowanceDays,
    carryoverEnabled: t.carryoverEnabled,
    carryoverMaxDays: t.carryoverMaxDays,
    sortOrder: t.sortOrder,
    archived: t.archivedAt !== null,
  };
}

function accountSnapshot(a: ExistingAccount) {
  return { name: a.name, role: a.role, departmentId: a.departmentId, managerId: a.managerId, canSelfApprove: a.canSelfApprove, isActive: a.isActive };
}

type AllowanceSnapshotInput = { userId: string; leaveTypeId: string; year: number; days: number; carriedOverDays: number; adjustmentDays: number };

function allowanceSnapshot(r: AllowanceSnapshotInput) {
  return { userId: r.userId, leaveTypeId: r.leaveTypeId, year: r.year, days: r.days, carriedOverDays: r.carriedOverDays, adjustmentDays: r.adjustmentDays };
}

/**
 * Compares TimeOff's balance with OOOhm's, through the same balance code the dashboard
 * uses, for every person and year the plan expects. Runs inside the import transaction,
 * after the rollover step, so it sees exactly what would be committed.
 */
async function reconcile(
  tx: Transaction,
  job: {
    plan: ImportPlan;
    excluded: ReadonlySet<number>;
    people: ReadonlyMap<number, { id: string; email: string; name: string }>;
    poolRow: LeaveTypeRow | null;
    allowancePolicy: string;
    currentYear: number;
    recarried: ReadonlyMap<string, { before: number; after: number }>;
  },
): Promise<TimeOffImportReport["reconciliation"]> {
  const expected = job.plan.expected.filter((e) => !job.excluded.has(e.personKey));
  const empty = { currentYear: job.currentYear, rows: [], mismatches: [], currentYearMismatches: 0 };
  if (!job.poolRow || expected.length === 0) return empty;
  const balanceOf = await loadBalances(tx, {
    allowancePolicy: job.allowancePolicy,
    leaveTypes: [job.poolRow],
    userIds: [...new Set(expected.map((e) => job.people.get(e.personKey)!.id))],
    years: [...new Set(expected.map((e) => e.year))],
  });

  const rows: ReconciliationRow[] = [];
  const mismatches: ReconciliationMismatch[] = [];
  for (const e of expected) {
    const person = job.people.get(e.personKey)!;
    const balance = balanceOf(person.id, job.poolRow.id, e.year);
    const ooohm = balance.tracked ? addDays(balance.remaining, balance.pending, balance.carriedOut) : null;
    const row: ReconciliationRow = {
      email: person.email,
      name: person.name,
      year: e.year,
      timeoff: e.timeoff.remaining,
      ooohm,
      diff: ooohm === null ? null : addDays(ooohm, -e.timeoff.remaining),
      pending: balance.pending,
      detail: e.timeoff,
    };
    rows.push(row);
    if (row.diff === 0) continue;

    const reasons: string[] = [];
    for (const d of job.plan.leaveCostDifferences.filter((x) => x.personKey === e.personKey && x.year === e.year)) {
      reasons.push(
        d.reason === "personal_schedule"
          ? `TimeOff leave ${d.timeoffLeaveId}: ${d.timeoff} day(s) on their own TimeOff schedule, ${d.ooohm} on the company's working days.`
          : d.reason === "company_holiday"
            ? `TimeOff leave ${d.timeoffLeaveId}: TimeOff takes ${d.timeoff} day(s) in ${d.year}; OOOhm counts ${d.ooohm}, because the company already has a holiday in it that TimeOff does not.`
            : `TimeOff leave ${d.timeoffLeaveId}: TimeOff takes ${d.timeoff} day(s) in ${d.year} (its half-day rule), OOOhm counts ${d.ooohm}.`,
      );
    }
    const carry = job.recarried.get(person.id);
    if (carry && e.year === job.currentYear) {
      reasons.push(`Carried over into ${e.year}: TimeOff stored ${carry.before}, OOOhm's year rollover computes ${carry.after} from ${e.year - 1}.`);
    }
    if (e.timeoff.beforeStart) reasons.push(`TimeOff shows nothing for ${e.year}: it is before their start date.`);
    if (ooohm === null) reasons.push(`OOOhm has no allowance for ${e.year} (outside their employment dates in TimeOff).`);
    if (reasons.length === 0) reasons.push("No known cause; compare the TimeOff detail with the person's OOOhm allowance page.");
    mismatches.push({ ...row, reasons });
  }
  rows.sort((a, b) => a.email.localeCompare(b.email) || a.year - b.year);
  mismatches.sort((a, b) => a.email.localeCompare(b.email) || a.year - b.year);
  return { currentYear: job.currentYear, rows, mismatches, currentYearMismatches: mismatches.filter((m) => m.year === job.currentYear).length };
}
