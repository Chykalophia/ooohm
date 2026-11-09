/**
 * Admin use cases for people: list, invite (create + sign-in link), edit, resend the
 * invite, deactivate and reactivate. Deleting someone, the step after deactivating them,
 * is in `admin-people-deletion`.
 *
 * Every write runs in one transaction that first takes the company lock
 * (`lockCompany`), so the rules that span several people hold under concurrency: the
 * last-admin guard, the manager-cycle rule and the invite rate limit. Every change
 * writes `audit_log` and an `events_outbox` row in that transaction; emails go out
 * only after commit.
 */
import { randomUUID } from "node:crypto";
import type { Transaction } from "@/db/types";
import type { Actor, Role } from "@/domain/actor";
import { assertCanAdminister } from "@/domain/admin-permissions";
import { DomainError, isDomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES, type Unattributed, type UserEventPayload } from "@/domain/events";
import { isUuid } from "@/domain/ids";
import { type PageCursor, readPage, textPart } from "@/domain/paging";
import { firstEditableAllowanceYear } from "@/domain/leave-type-settings";
import {
  assertKeepsAnActiveAdmin,
  assertNotSelfDeactivation,
  assertValidManager,
  isRole,
  managerCandidates,
  normalizeEmail,
  normalizePersonName,
  type ReportingLine,
} from "@/domain/people";
import { personLabel } from "@/domain/person";
import { yearInTimeZone } from "@/lib/dates";
import { log } from "@/lib/log";
import type { ServiceContext } from "@/server/context";
import { rerouteApprovals } from "./approval-routing";
import { countLiveApiKeys } from "@/server/repositories/api-keys";
import { countRecentActions } from "@/server/repositories/audit-log";
import { findCompany, lockCompany } from "@/server/repositories/companies";
import { findDepartment, listDepartments } from "@/server/repositories/departments";
import { isUniqueViolation } from "@/server/repositories/errors";
import { countLiveEndpoints } from "@/server/repositories/webhooks";
import {
  listPendingAssignedTo,
  listPendingRequestsOf,
  listPendingSelfRouted,
} from "@/server/repositories/leave-requests";
import { listLeaveTypesWithAllowance } from "@/server/repositories/leave-types";
import {
  deleteSessionsOf,
  emailInUse,
  findPerson,
  insertPerson,
  listActiveAdmins,
  listPeople as listPeopleRows,
  listPeopleNames,
  listReportingLines,
  lockPerson,
  type PeopleFilter,
  type PersonRow,
  updatePerson as updatePersonRow,
} from "@/server/repositories/users";
import { assertActiveAdmin, recordAdminChange } from "./admin-access";
import { cancelScheduledScrubIn } from "./admin-people-deletion";
import { type BalanceSummary, summarizeBalances } from "./balances";
import { revokeFeedsOnDeactivation } from "./calendar-feeds";
import { activeContacts, recordReassignment, summarize } from "./leave-changes";
import { commitThenNotify, type Notification } from "./notify";

/** Most invites (new or resent) one admin may send per {@link INVITE_WINDOW_MINUTES}. */
export const INVITE_LIMIT = 30;
export const INVITE_WINDOW_MINUTES = 60;
/** People per page of the admin list. */
export const PEOPLE_PAGE_SIZE = 50;

/**
 * A people page's key: `[lower(name), email]`. Generous on length: imported names are
 * not held to the form's limit, and a key too long only reads as the first page.
 */
const PEOPLE_KEY = [textPart(500), textPart(320)] as const;

/** What an admin sets about a person. */
export interface PersonInput {
  name: string;
  departmentId: string | null;
  managerId: string | null;
  role: string;
  canSelfApprove: boolean;
}

export interface InviteInput extends PersonInput {
  email: string;
}

/** The audited view of a person. */
export function personSnapshot(p: PersonRow) {
  return {
    name: p.name,
    email: p.email,
    role: p.role,
    departmentId: p.departmentId,
    managerId: p.managerId,
    canSelfApprove: p.canSelfApprove,
    isActive: p.isActive,
  };
}

/** The `user.*` event payload for a person, before attribution. */
export function personPayload(p: PersonRow): Unattributed<UserEventPayload> {
  return {
    userId: p.id,
    email: p.email,
    name: p.name,
    role: p.role,
    departmentId: p.departmentId,
    managerId: p.managerId,
    canSelfApprove: p.canSelfApprove,
    isActive: p.isActive,
  };
}

function lineMap(rows: readonly ({ id: string } & ReportingLine)[]): Map<string, ReportingLine> {
  return new Map(rows.map((r) => [r.id, { managerId: r.managerId, isActive: r.isActive }]));
}

/** @throws DomainError `invalid_input` for a malformed field. */
function normalizePersonInput(input: PersonInput): { name: string; role: Role; departmentId: string | null; managerId: string | null; canSelfApprove: boolean } {
  if (!isRole(input.role)) throw new DomainError("invalid_input", "Unknown role.");
  if (input.departmentId !== null && !isUuid(input.departmentId)) throw new DomainError("invalid_input", "Unknown department.");
  if (input.managerId !== null && (input.managerId.length === 0 || input.managerId.length > 100)) {
    throw new DomainError("invalid_input", "Unknown manager.");
  }
  return {
    name: normalizePersonName(input.name),
    role: input.role,
    departmentId: input.departmentId,
    managerId: input.managerId,
    canSelfApprove: input.canSelfApprove === true,
  };
}

/** @throws DomainError `invalid_input` when the department is not one of the company's. */
async function assertDepartment(tx: Transaction, companyId: string, departmentId: string | null): Promise<void> {
  if (departmentId !== null && !(await findDepartment(tx, companyId, departmentId))) {
    throw new DomainError("invalid_input", "Unknown department.");
  }
}

/**
 * Counts the actor's invites (new and resent) in the window. Runs under the company
 * lock, so parallel invites by one admin cannot all slip under the cap.
 *
 * @throws DomainError `rate_limited`.
 */
async function assertUnderInviteLimit(tx: Transaction, actor: Actor): Promise<void> {
  const sent = await countRecentActions(
    tx,
    // People added by a CSV import have their own limit (`admin-people-import`).
    { companyId: actor.companyId, actorId: actor.id, actions: [ADMIN_EVENT_TYPES.userCreated, ADMIN_EVENT_TYPES.userInviteResent], via: null },
    INVITE_WINDOW_MINUTES,
  );
  if (sent >= INVITE_LIMIT) throw new DomainError("rate_limited");
}

/**
 * The invite email for `person`. The sign-in link is issued at send time, after commit,
 * because the account it signs into must exist first. A failure (link or SMTP) is
 * logged as `invite_email_failed` with the person's id, never their address.
 */
export function inviteEmail(ctx: ServiceContext, person: PersonRow, inviterName: string, companyName: string): Notification {
  return {
    type: "invite",
    to: person.email,
    data: { userId: person.id, recipientName: person.name, inviterName, companyName, signInUrl: `${ctx.appUrl}/sign-in` },
  };
}

/** Locks the company and checks the actor is still an active admin of it. */
export async function beginAdminChange(tx: Transaction, actor: Actor) {
  const company = await lockCompany(tx, actor.companyId);
  if (!company) throw new DomainError("no_company");
  await assertActiveAdmin(tx, actor);
  return company;
}

export async function inviterName(tx: Transaction, actor: Actor): Promise<string> {
  const me = await findPerson(tx, actor.companyId, actor.id);
  return me ? personLabel(me) : "";
}

/**
 * One page of the company's people for the admin list, by name, with department and
 * manager names. Deleted people (tombstones) never appear. Three queries in parallel:
 * the page, the departments (for the filter) and the company (its time zone, for dates).
 *
 * @param page From a previous page's `previous` or `next`; the first page when absent.
 * @returns At most {@link PEOPLE_PAGE_SIZE} people, and the cursors either side.
 * @throws DomainError `forbidden` for a non-admin, `no_company`.
 */
export async function listPeople(ctx: ServiceContext, actor: Actor, filter: Omit<PeopleFilter, "page">, page?: PageCursor) {
  assertCanAdminister(actor);
  const departmentId = filter.departmentId && isUuid(filter.departmentId) ? filter.departmentId : undefined;
  const [people, departments, company] = await Promise.all([
    readPage({
      cursor: page,
      size: PEOPLE_PAGE_SIZE,
      checks: PEOPLE_KEY,
      read: (request, limit) => listPeopleRows(ctx.db, actor.companyId, { ...filter, departmentId, page: request }, limit),
      keyOf: (p) => [p.sortName, p.email],
    }),
    listDepartments(ctx.db, actor.companyId),
    findCompany(ctx.db, actor.companyId),
  ]);
  if (!company) throw new DomainError("no_company");
  return { people: people.items, previous: people.previous, next: people.next, departments, timezone: company.timezone };
}

/**
 * The pickers the invite and edit forms need: departments, and the people `personId`
 * may report to (active, not themself, no reporting loop). Three queries in parallel.
 */
export async function getPersonFormOptions(ctx: ServiceContext, actor: Actor, personId: string | null) {
  assertCanAdminister(actor);
  const [departments, lines, names] = await Promise.all([
    listDepartments(ctx.db, actor.companyId),
    listReportingLines(ctx.db, actor.companyId),
    listPeopleNames(ctx.db, actor.companyId),
  ]);
  const allowed = new Set(managerCandidates(personId, lineMap(lines)));
  // Keep the person's current manager pickable even when no longer valid (e.g.
  // deactivated), so saving other fields never silently clears it. Saving it unchanged
  // is allowed; choosing it anew is not.
  const current = personId ? lines.find((l) => l.id === personId)?.managerId : null;
  return {
    departments,
    managers: names
      .filter((n) => allowed.has(n.id) || n.id === current)
      .map((n) => ({ id: n.id, label: n.isActive ? personLabel(n) : `${personLabel(n)} (deactivated)` })),
  };
}

/**
 * One person as their admin page shows them, with their balance per active leave type
 * (plus archived types they have an allowance or booked days for) for `year` (default:
 * the current year in the company's time zone), computed by the same balance code as
 * their dashboard. `balances` is `null` when the company's
 * allowance policy is unknown.
 *
 * @throws DomainError `forbidden` for a non-admin, `not_found` for someone outside the
 *   actor's company.
 */
export async function getPersonDetail(ctx: ServiceContext, actor: Actor, userId: string, year?: number) {
  assertCanAdminister(actor);
  const [person, company, types] = await Promise.all([
    findPerson(ctx.db, actor.companyId, userId),
    findCompany(ctx.db, actor.companyId),
    listLeaveTypesWithAllowance(ctx.db, actor.companyId),
  ]);
  if (!person) throw new DomainError("not_found");
  if (!company) throw new DomainError("no_company");
  const balanceYear = year ?? yearInTimeZone(company.timezone, ctx.now());
  const balances: BalanceSummary | null = await summarizeBalances(ctx.db, person, {
    allowancePolicy: company.allowancePolicy,
    types,
    year: balanceYear,
  }).catch((err: unknown) => {
    if (!isDomainError(err, "policy_unavailable")) throw err;
    log.error({ err, companyId: actor.companyId }, "allowance_policy_unavailable");
    return null;
  });
  return {
    person,
    timezone: company.timezone,
    year: balanceYear,
    /** Allowances of years before this one are closed; see `firstEditableAllowanceYear`. */
    firstEditableYear: firstEditableAllowanceYear(yearInTimeZone(company.timezone, ctx.now())),
    balances,
    /** Each type's allowance settings, by id, for the allowance editor. */
    leaveTypes: new Map(types.map((t) => [t.id, { countsAgainstAllowance: t.countsAgainstAllowance, defaultAllowanceDays: t.defaultAllowanceDays }])),
  };
}

/**
 * Invites a person: creates their account in the actor's company and, after commit,
 * emails them a sign-in link. Never goes through Better Auth's sign-up, so access stays
 * invite-only. Inviting an admin re-routes any request an admin had routed to
 * themself for want of another admin (see {@link rerouteApprovals}).
 *
 * @returns The new person.
 * @throws DomainError `forbidden` (not an admin), `invalid_input`, `already_exists`
 *   (the email has an account, in this company or any other: the message does not say
 *   which), `invalid_manager`, or `rate_limited` (over {@link INVITE_LIMIT} invites
 *   in {@link INVITE_WINDOW_MINUTES} minutes).
 */
export async function invitePerson(ctx: ServiceContext, actor: Actor, input: InviteInput): Promise<PersonRow> {
  assertCanAdminister(actor);
  const email = normalizeEmail(input.email);
  const fields = normalizePersonInput(input);

  try {
    return await commitThenNotify(ctx, actor.companyId, async (tx) => {
      const company = await beginAdminChange(tx, actor);
      await assertUnderInviteLimit(tx, actor);
      if (await emailInUse(tx, email)) throw new DomainError("already_exists");
      await assertDepartment(tx, actor.companyId, fields.departmentId);
      assertValidManager(null, fields.managerId, lineMap(await listReportingLines(tx, actor.companyId)));

      const person = await insertPerson(tx, { id: randomUUID(), companyId: actor.companyId, email, ...fields });
      await recordAdminChange(tx, actor, {
        type: ADMIN_EVENT_TYPES.userCreated,
        entityType: "user",
        entityId: person.id,
        subjectUserId: person.id,
        before: null,
        after: personSnapshot(person),
        payload: personPayload(person),
      });
      const rerouted = person.role === "admin" ? await rerouteApprovals(ctx, tx, actor, await listPendingSelfRouted(tx, actor.companyId)) : null;
      return {
        result: person,
        notify: [inviteEmail(ctx, person, await inviterName(tx, actor), company.name), ...(rerouted?.notify ?? [])],
      };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError("already_exists");
    throw err;
  }
}

/**
 * Emails an active person a fresh sign-in link, as the invite did. Counts towards the
 * invite rate limit and is audited (`user.invite_resent`).
 *
 * @throws DomainError `forbidden` (not an admin, or the person is deactivated),
 *   `not_found`, or `rate_limited`.
 */
export async function resendInvite(ctx: ServiceContext, actor: Actor, userId: string): Promise<PersonRow> {
  assertCanAdminister(actor);
  return commitThenNotify(ctx, actor.companyId, async (tx) => {
    const company = await beginAdminChange(tx, actor);
    const person = await findPerson(tx, actor.companyId, userId);
    if (!person) throw new DomainError("not_found");
    if (!person.isActive) throw new DomainError("forbidden");
    await assertUnderInviteLimit(tx, actor);
    await recordAdminChange(tx, actor, {
      type: ADMIN_EVENT_TYPES.userInviteResent,
      entityType: "user",
      entityId: person.id,
      subjectUserId: person.id,
      before: null,
      after: { email: person.email },
      payload: personPayload(person),
    });
    return { result: person, notify: [inviteEmail(ctx, person, await inviterName(tx, actor), company.name)] };
  });
}

/** What an edit did. */
export interface PersonUpdateResult {
  person: PersonRow;
  /** Pending requests that moved to another approver because of the edit. */
  requestsReassigned: number;
}

/**
 * Edits a person's name, department, manager, role and self-approval. Their email is
 * their sign-in identity and cannot be changed here.
 *
 * Approval rights follow the edit at once, in the same transaction, so a change never
 * leaves someone deciding requests they no longer have a reason to decide:
 * - Demoting an admin re-routes the pending requests assigned to them by the approval
 *   rule (see {@link rerouteApprovals}); those whose requester they still manage stay.
 *   Their own pending requests are re-routed too: one they had routed to themself as
 *   the only admin moves to whoever the rule now picks.
 * - Changing someone's manager or department re-routes that person's own pending
 *   requests, so the new manager (or department manager, or the admin fallback) gets
 *   them and the old one loses them. That includes an admin's request routed to themself.
 * - Promoting someone to admin re-routes every request an admin had routed to themself
 *   for want of another admin.
 * Each moved request writes `leave_request.reassigned` / `leave.reassigned`, and its
 * new approver gets a review email after commit.
 *
 * @returns The person after the change (unchanged, with nothing recorded, when nothing differs).
 * @throws DomainError `forbidden`, `not_found`, `invalid_input`, `invalid_manager`,
 *   `manager_cycle`, or `last_admin` (demoting the last active admin).
 */
export async function updatePerson(ctx: ServiceContext, actor: Actor, userId: string, input: PersonInput): Promise<PersonUpdateResult> {
  assertCanAdminister(actor);
  const fields = normalizePersonInput(input);
  return commitThenNotify(ctx, actor.companyId, async (tx) => {
    await beginAdminChange(tx, actor);
    const before = await lockPerson(tx, actor.companyId, userId);
    if (!before) throw new DomainError("not_found");
    await assertDepartment(tx, actor.companyId, fields.departmentId);
    if (fields.managerId !== before.managerId) {
      assertValidManager(before.id, fields.managerId, lineMap(await listReportingLines(tx, actor.companyId)));
    }
    if (fields.role !== before.role) {
      const admins = await listActiveAdmins(tx, actor.companyId);
      assertKeepsAnActiveAdmin(
        { personId: before.id, before, after: { role: fields.role, isActive: before.isActive } },
        admins.map((a) => a.id),
      );
    }

    const changed = (Object.keys(fields) as (keyof typeof fields)[]).filter((k) => fields[k] !== before[k]);
    if (changed.length === 0) return { result: { person: before, requestsReassigned: 0 }, notify: [] };
    const after = await updatePersonRow(tx, actor.companyId, before.id, fields);
    await recordAdminChange(tx, actor, {
      type: ADMIN_EVENT_TYPES.userUpdated,
      entityType: "user",
      entityId: after.id,
      subjectUserId: after.id,
      before: personSnapshot(before),
      after: personSnapshot(after),
      payload: personPayload(after),
    });

    const demoted = before.role === "admin" && after.role !== "admin";
    const affected = [
      ...(demoted ? await listPendingAssignedTo(tx, actor.companyId, after.id) : []),
      ...(demoted || before.managerId !== after.managerId || before.departmentId !== after.departmentId
        ? await listPendingRequestsOf(tx, actor.companyId, after.id)
        : []),
      ...(before.role !== "admin" && after.role === "admin" ? await listPendingSelfRouted(tx, actor.companyId) : []),
    ];
    const { reassigned, notify } = await rerouteApprovals(ctx, tx, actor, affected);
    return { result: { person: after, requestsReassigned: reassigned }, notify };
  });
}

/** What a deactivation did besides flipping the flag. */
export interface DeactivationResult {
  person: PersonRow;
  sessionsRevoked: number;
  feedsRevoked: number;
  /** Pending requests that were waiting on this person and now wait on someone else. */
  requestsReassigned: number;
  /**
   * Unrevoked API keys and undeleted webhook endpoints this person created. They belong
   * to the company and keep working; they are reported because the person saw each key
   * and signing secret in full, so an admin may want to revoke or rotate them.
   */
  liveApiKeysCreated: number;
  liveWebhookEndpointsCreated: number;
}

/**
 * Deactivates a person: they can no longer sign in (every session is deleted, and the
 * session hook refuses new ones), their calendar feed links are turned off, and they
 * drop out of approvals, calendars and emails. Their own requests stay as they are.
 *
 * Pending requests they were assigned to approve move to whoever the approval rule
 * now picks for each requester (their active manager, else their department's active
 * manager, else the longest-standing other active admin; never self-approval), each with a `leave.reassigned` event and a
 * review email to the new approver after commit.
 *
 * API keys and webhook endpoints they created stay (they belong to the company); the
 * result counts the live ones so the admin can review them.
 *
 * Doing it again to someone already inactive changes and records nothing.
 *
 * @throws DomainError `forbidden`, `not_found`, `self_change_not_allowed` (the actor
 *   themself), or `last_admin`.
 */
export async function deactivatePerson(ctx: ServiceContext, actor: Actor, userId: string): Promise<DeactivationResult> {
  assertCanAdminister(actor);
  assertNotSelfDeactivation(actor.id, userId);
  return commitThenNotify(ctx, actor.companyId, async (tx) => {
    await beginAdminChange(tx, actor);
    const before = await lockPerson(tx, actor.companyId, userId);
    if (!before) throw new DomainError("not_found");
    const credentials = async () => ({
      liveApiKeysCreated: await countLiveApiKeys(tx, actor.companyId, before.id),
      liveWebhookEndpointsCreated: await countLiveEndpoints(tx, actor.companyId, before.id),
    });
    if (!before.isActive) {
      return { result: { person: before, sessionsRevoked: 0, feedsRevoked: 0, requestsReassigned: 0, ...(await credentials()) }, notify: [] };
    }
    const adminsBefore = await listActiveAdmins(tx, actor.companyId);
    assertKeepsAnActiveAdmin(
      { personId: before.id, before, after: { role: before.role, isActive: false } },
      adminsBefore.map((a) => a.id),
    );

    const now = ctx.now();
    const after = await updatePersonRow(tx, actor.companyId, before.id, { isActive: false });
    const sessionsRevoked = await deleteSessionsOf(tx, before.id);
    const feedsRevoked = await revokeFeedsOnDeactivation(tx, before.id, actor.source, now);
    const { reassigned, notify } = await rerouteApprovals(ctx, tx, actor, await listPendingAssignedTo(tx, actor.companyId, before.id));

    await recordAdminChange(tx, actor, {
      type: ADMIN_EVENT_TYPES.userDeactivated,
      entityType: "user",
      entityId: after.id,
      subjectUserId: after.id,
      before: personSnapshot(before),
      after: { ...personSnapshot(after), sessionsRevoked, feedsRevoked, requestsReassigned: reassigned },
      payload: personPayload(after),
    });
    return { result: { person: after, sessionsRevoked, feedsRevoked, requestsReassigned: reassigned, ...(await credentials()) }, notify };
  });
}

/**
 * Reactivates a person: they can sign in again (with a new link; old sessions are
 * gone) and appear in approvals and calendars. Calendar links turned off at
 * deactivation stay off; they can create new ones. Requests that moved off them while
 * they were away stay where they are, except any an admin had routed to themself for
 * want of another approver: those are re-routed, so a returning admin or manager takes
 * them (see {@link rerouteApprovals}). A full scrub scheduled for them is cancelled
 * (`user.deletion_cancelled`), since only a deactivated person can wait for one.
 *
 * Doing it to someone already active changes and records nothing.
 *
 * @throws DomainError `forbidden` or `not_found`.
 */
export async function reactivatePerson(ctx: ServiceContext, actor: Actor, userId: string): Promise<PersonRow> {
  assertCanAdminister(actor);
  return commitThenNotify(ctx, actor.companyId, async (tx) => {
    await beginAdminChange(tx, actor);
    const before = await lockPerson(tx, actor.companyId, userId);
    if (!before) throw new DomainError("not_found");
    if (before.isActive) return { result: before, notify: [] };
    // Only a deactivated person can wait for a scrub, so coming back cancels it (audited).
    await cancelScheduledScrubIn(tx, actor, before);
    const after = await updatePersonRow(tx, actor.companyId, before.id, { isActive: true });
    await recordAdminChange(tx, actor, {
      type: ADMIN_EVENT_TYPES.userReactivated,
      entityType: "user",
      entityId: after.id,
      subjectUserId: after.id,
      before: personSnapshot(before),
      after: personSnapshot(after),
      payload: personPayload(after),
    });
    const { notify } = await rerouteApprovals(ctx, tx, actor, await listPendingSelfRouted(tx, actor.companyId));
    return { result: after, notify };
  });
}
