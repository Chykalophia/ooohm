/**
 * Inbound sync: applies people and allowances an adapter read from another system.
 *
 * Writes go through the same rules as an admin's edits: people under the company lock
 * (as invites take it), allowances under each person's member lock (the rule for
 * every writer of balance inputs), and every change records `audit_log` + its outbox
 * event (`user.created`, `user.updated`, `balance.adjusted` with `reason: "sync"`) in the
 * same transaction, attributed by {@link SyncTrigger}: the admin who pressed Sync now,
 * via `adapter_sync:<id>`, or the system process `adapter_sync:<id>` for a scheduled sync.
 * The audit snapshot also keeps `source: "adapter:<id>"`, which migration 0010 read to backfill older rows.
 *
 * Access stays invite-only: a sync creates the account row and nothing else. No session,
 * no sign-in link, no email. New people are created **inactive** unless the caller passes
 * `activateNewUsers`; an inactive person cannot sign in until an admin reactivates them,
 * which is the sync's equivalent of an invite. With `activateNewUsers` they can ask for a
 * sign-in link on the sign-in page, like any invited person whose link expired.
 */
import { randomUUID } from "node:crypto";
import type { Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { adapterSyncProcess, bySystem, type ChangeSource, through } from "@/domain/change-source";
import { DomainError, isDomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES, type Unattributed, type UserEventPayload } from "@/domain/events";
import { assertAllowanceYear, MAX_ALLOWANCE_DAYS, normalizeDayAmount } from "@/domain/leave-type-settings";
import { normalizeEmail, normalizePersonName } from "@/domain/people";
import { yearInTimeZone } from "@/lib/dates";
import type { ServiceContext } from "@/server/context";
import type { InboundBalance, InboundUser } from "@/server/integrations/adapter";
import { findAllowance } from "@/server/repositories/balances";
import { recordChange } from "@/server/repositories/change-log";
import { findCompany, lockCompany } from "@/server/repositories/companies";
import { isUniqueViolation } from "@/server/repositories/errors";
import { findLeaveTypeByCode } from "@/server/repositories/leave-types";
import { findPersonByEmail, insertPerson, lockMember, type PersonRow, updatePerson } from "@/server/repositories/users";
import { assertActiveAdmin } from "./admin-access";
import { writeAllowance } from "./admin-allowances";
import { inTransaction } from "./notify";

/**
 * Who started a sync, which decides both its authorization and what every change it
 * makes records:
 *
 * - `admin`: an admin pressed Sync now. Every write transaction re-checks them first
 *   (`assertActiveAdmin`), so one demoted or deactivated while the adapter was reading is
 *   refused before anything is written. Changes name them, via `adapter_sync:<id>`. The
 *   actor must belong to the sync's company.
 * - `schedule`: a scheduled sync, configured by an admin beforehand. Changes name the
 *   system process `adapter_sync:<id>`.
 */
export type SyncTrigger = { kind: "admin"; actor: Actor } | { kind: "schedule" };

export interface InboundSyncInput {
  companyId: string;
  /** The adapter's id; changes record `adapter_sync:<id>`. */
  adapterId: string;
  trigger: SyncTrigger;
  users?: readonly InboundUser[];
  balances?: readonly InboundBalance[];
  /** Let people the sync creates sign in at once. Default false: they wait, inactive, for an admin. */
  activateNewUsers?: boolean;
}

export type SkippedUser = { email: string; reason: "invalid" | "other_company" };
export type SkippedBalance = {
  email: string;
  leaveTypeCode: string;
  year: number;
  reason: "invalid" | "unknown_person" | "unknown_leave_type" | "closed_year";
};

export interface InboundSyncResult {
  users: { created: number; updated: number; unchanged: number; skipped: SkippedUser[] };
  balances: { changed: number; unchanged: number; skipped: SkippedBalance[] };
}

function snapshot(p: PersonRow, source: string) {
  return {
    name: p.name,
    email: p.email,
    role: p.role,
    departmentId: p.departmentId,
    managerId: p.managerId,
    canSelfApprove: p.canSelfApprove,
    isActive: p.isActive,
    source,
  };
}

function userPayload(p: PersonRow): Unattributed<UserEventPayload> {
  return {
    userId: p.id,
    email: p.email,
    name: p.name,
    role: p.role,
    departmentId: p.departmentId,
    levelId: p.levelId,
    managerId: p.managerId,
    canSelfApprove: p.canSelfApprove,
    isActive: p.isActive,
  };
}

/** The admin to re-check before each write, or `null` for a scheduled sync. */
function adminOf(input: InboundSyncInput): Actor | null {
  return input.trigger.kind === "admin" ? input.trigger.actor : null;
}

/** What every change of this sync records. */
function sourceOf(input: InboundSyncInput): ChangeSource {
  const process = adapterSyncProcess(input.adapterId);
  return input.trigger.kind === "admin" ? through(input.trigger.actor.source, process) : bySystem(process);
}

async function recordUser(tx: Transaction, input: InboundSyncInput, type: string, before: PersonRow | null, after: PersonRow) {
  const marker = `adapter:${input.adapterId}`;
  await recordChange(tx, {
    source: sourceOf(input),
    audit: {
      companyId: input.companyId,
      action: type,
      entityType: "user",
      entityId: after.id,
      subjectUserId: after.id,
      before: before ? snapshot(before, marker) : null,
      after: snapshot(after, marker),
    },
    event: { companyId: input.companyId, type, payload: userPayload(after) },
  });
}

async function syncUsers(ctx: ServiceContext, input: InboundSyncInput, result: InboundSyncResult): Promise<void> {
  const users = input.users ?? [];
  if (users.length === 0) return;
  await inTransaction(ctx, async (tx) => {
    if (!(await lockCompany(tx, input.companyId))) throw new DomainError("no_company");
    const admin = adminOf(input);
    if (admin) await assertActiveAdmin(tx, admin);
    for (const raw of users) {
      let email: string;
      let name: string;
      try {
        email = normalizeEmail(String(raw.email ?? ""));
        name = normalizePersonName(String(raw.name ?? ""));
      } catch (err) {
        if (!isDomainError(err)) throw err;
        result.users.skipped.push({ email: String(raw.email ?? "").slice(0, 254), reason: "invalid" });
        continue;
      }
      const existing = await findPersonByEmail(tx, email);
      if (existing && existing.companyId !== input.companyId) {
        result.users.skipped.push({ email, reason: "other_company" });
        continue;
      }
      if (existing) {
        if (existing.name === name) {
          result.users.unchanged++;
          continue;
        }
        const after = await updatePerson(tx, input.companyId, existing.id, { name });
        await recordUser(tx, input, ADMIN_EVENT_TYPES.userUpdated, existing, after);
        result.users.updated++;
        continue;
      }
      const created = await insertPerson(tx, {
        id: randomUUID(),
        companyId: input.companyId,
        email,
        name,
        role: "employee",
        departmentId: null,
        managerId: null,
        canSelfApprove: false,
        isActive: input.activateNewUsers === true,
      });
      await recordUser(tx, input, ADMIN_EVENT_TYPES.userCreated, null, created);
      result.users.created++;
    }
  });
}

async function syncBalances(ctx: ServiceContext, input: InboundSyncInput, result: InboundSyncResult): Promise<void> {
  const balances = input.balances ?? [];
  if (balances.length === 0) return;
  const company = await findCompany(ctx.db, input.companyId);
  if (!company) throw new DomainError("no_company");
  const currentYear = yearInTimeZone(company.timezone, ctx.now());

  for (const raw of balances) {
    const leaveTypeCode = String(raw.leaveTypeCode ?? "").trim().toUpperCase();
    const skip = (reason: SkippedBalance["reason"], email = String(raw.email ?? "").slice(0, 254)) =>
      result.balances.skipped.push({ email, leaveTypeCode: leaveTypeCode.slice(0, 12), year: Number(raw.year), reason });
    let email: string;
    let days: number;
    let adjustment: number | undefined;
    try {
      email = normalizeEmail(String(raw.email ?? ""));
      days = normalizeDayAmount(Number(raw.days), { min: 0, max: MAX_ALLOWANCE_DAYS });
      adjustment = raw.adjustmentDays === undefined ? undefined : normalizeDayAmount(Number(raw.adjustmentDays), { min: -MAX_ALLOWANCE_DAYS, max: MAX_ALLOWANCE_DAYS });
    } catch (err) {
      if (!isDomainError(err)) throw err;
      skip("invalid");
      continue;
    }
    try {
      assertAllowanceYear(raw.year, currentYear);
    } catch (err) {
      if (!isDomainError(err)) throw err;
      skip("closed_year", email);
      continue;
    }

    const outcome = await inTransaction(ctx, async (tx) => {
      const admin = adminOf(input);
      if (admin) await assertActiveAdmin(tx, admin);
      const person = await findPersonByEmail(tx, email);
      if (!person || person.companyId !== input.companyId) return "unknown_person" as const;
      const member = await lockMember(tx, input.companyId, person.id);
      if (!member) return "unknown_person" as const;
      const leaveType = await findLeaveTypeByCode(tx, input.companyId, leaveTypeCode);
      if (!leaveType) return "unknown_leave_type" as const;
      const existing = await findAllowance(tx, { userId: member.id, leaveTypeId: leaveType.id, year: raw.year });
      const { changed } = await writeAllowance(tx, {
        company,
        currentYear,
        member,
        leaveType,
        year: raw.year,
        days,
        adjustmentDays: adjustment ?? existing?.adjustmentDays ?? 0,
        reason: "sync",
        source: sourceOf(input),
        note: `Synced from adapter:${input.adapterId}`,
      });
      return changed ? ("changed" as const) : ("unchanged" as const);
    });
    if (outcome === "changed") result.balances.changed++;
    else if (outcome === "unchanged") result.balances.unchanged++;
    else skip(outcome, email);
  }
}

/**
 * Applies what an adapter's `syncUsers` and `syncBalances` returned, people first (so an
 * allowance can name someone created in the same sync).
 *
 * - **People** are matched by email (lowercased). Someone in this company is renamed if
 *   the name differs (`user.updated`); nothing else about them changes (role, manager,
 *   active). An unknown email creates an employee with no department or manager
 *   (`user.created`), inactive unless `activateNewUsers`. An email that belongs to
 *   another company is skipped, as is a malformed entry. All people are written in one
 *   transaction under the company lock.
 * - **Allowances** set `days` (and `adjustmentDays` when given) for one person, leave
 *   type (by code) and year, like an admin's override: last year and later only, the
 *   rollover's `carried_over_days` untouched, last year re-carried at once. Each runs in
 *   its own transaction under the person's member lock. Unknown people or leave types,
 *   closed years and malformed amounts are skipped and reported.
 *
 * The caller authorizes: `syncAdapterNow` checks the admin before the adapter reads, and
 * passes them as the `admin` trigger, re-checked inside every write transaction; a
 * scheduled sync (`schedule`) is configured by one. Skips are reported, never thrown, so
 * one bad row does not stop a sync.
 *
 * @throws DomainError `forbidden` when the admin trigger's actor is not (or no longer) an
 *   active admin of the company; writes already committed by then stay, later ones are not
 *   made. `no_company`, or `policy_unavailable` when last year is synced under an
 *   unknown policy.
 */
export async function applyInboundSync(ctx: ServiceContext, input: InboundSyncInput): Promise<InboundSyncResult> {
  if (input.trigger.kind === "admin" && input.trigger.actor.companyId !== input.companyId) throw new DomainError("forbidden");
  const result: InboundSyncResult = {
    users: { created: 0, updated: 0, unchanged: 0, skipped: [] },
    balances: { changed: 0, unchanged: 0, skipped: [] },
  };
  try {
    await syncUsers(ctx, input, result);
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError("conflict");
    throw err;
  }
  await syncBalances(ctx, input, result);
  return result;
}
