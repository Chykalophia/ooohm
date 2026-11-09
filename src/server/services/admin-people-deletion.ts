/**
 * Admin use cases for deleting a person, the step after deactivating them:
 *
 * - **Full scrub** (`scrubbed`, the default): nothing about them remains. Their requests,
 *   allowances and the audit entries about them are deleted, their name and email are
 *   redacted from every stored payload, and their row becomes "Former employee #<id>".
 * - **Keep records** (`records_kept`): their sign-in and email go; their history stays
 *   under "<Name> (deleted)", and the email can be invited again as a new account.
 *
 * The `user` row is never removed: it stays as a tombstone so every foreign key holds.
 * Either delete runs in one transaction under the company lock and the person's member
 * lock, and writes exactly one audit row (`user.deleted`, `after` = mode and counts) and
 * one `user.deleted` event, neither with a name or email.
 *
 * With the company's grace option on, a full scrub is scheduled instead
 * (`DELETION_GRACE_DAYS`, with undo) and the daily job runs it ({@link runDueScrubs}),
 * attributed to the system on the requesting admin's behalf.
 */
import type { Executor, Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { assertCanAdminister } from "@/domain/admin-permissions";
import { bySystem, CHANGE_PROCESSES, type ChangeSource } from "@/domain/change-source";
import { type CsvCell, toCsv } from "@/domain/csv";
import { DomainError } from "@/domain/errors";
import {
  ADMIN_EVENT_TYPES,
  type DepartmentEventPayload,
  RECORDS_EXPORTED_AUDIT_ACTION,
  type Unattributed,
  type UserDeletedPayload,
  type UserDeletionScheduleEventPayload,
} from "@/domain/events";
import {
  assertConfirmed,
  assertDeletable,
  confirmationTarget,
  type DeletionBlockers,
  type DeletionCounts,
  type DeletionMode,
  deletionBlockers,
  describeDeletion,
  isBlocked,
  isDeletionMode,
  nameInUse,
  namesInOwnRecords,
  type PersonRedaction,
  personRedactions,
  redactionNeedles,
  redactJson,
  redactJsonText,
  redactText,
  scrubDueAt,
  shortStableId,
  tombstoneEmail,
  tombstoneName,
} from "@/domain/person-deletion";
import { personLabel } from "@/domain/person";
import { log } from "@/lib/log";
import type { ServiceContext } from "@/server/context";
import { recordAuditOnly, recordChange } from "@/server/repositories/change-log";
import { type CompanyRow, findCompany, lockCompany } from "@/server/repositories/companies";
import { listLeaveTypesWithAllowance } from "@/server/repositories/leave-types";
import {
  clearManagerOf,
  clearScrubSchedule,
  countDeletionFacts,
  countPendingAssignedTo,
  deleteAllowancesOf,
  deleteAuditAbout,
  deleteLeaveRequestsOf,
  deleteSignInOf,
  findScrubRequest,
  listAdapterErrorsMentioning,
  listAuditMentioning,
  listDeliveriesMentioning,
  type DueScrubCursor,
  listDueScrubs,
  listEventsMentioning,
  listImportRunsMentioning,
  listNotesMentioning,
  listOtherNames,
  listOwnNameRecords,
  listRecordYears,
  listReportsOf,
  listRequestsForExport,
  listSettingLabelsMentioning,
  scheduleScrub,
  setAdapterError,
  setAuditSnapshots,
  setEventPayload,
  setImportRunText,
  setNotes,
  setSettingLabel,
  rewriteDelivery,
  supersedeAdapterAttempts,
  withdrawPendingRequestsOf,
  writeTombstone,
} from "@/server/repositories/person-deletion";
import { clearDepartmentsManagedBy } from "@/server/repositories/departments";
import { findPerson, listActiveAdmins, lockPerson, type PersonRow } from "@/server/repositories/users";
import { assertActiveAdmin, recordAdminChange } from "./admin-access";
import { listAuditEntriesAbout } from "./audit-log";
import { loadBalances } from "./balances";
import { inTransaction } from "./notify";

/** Most scheduled scrubs one daily run carries out; the rest wait for the next run. */
export const SCRUBS_PER_RUN = 50;

/** Most due scrubs one run looks at, carried out or not, so blocked ones cannot make a run endless. */
const SCRUB_CHECKS_PER_RUN = 500;

/** What the delete confirmation shows: what blocks it, or what each mode would remove. */
export interface DeletionPreview {
  person: PersonRow;
  /** What the admin types to confirm: the name as shown (the email when it is blank). */
  confirmName: string;
  blockers: DeletionBlockers;
  blocked: boolean;
  counts: DeletionCounts;
  describe: Record<DeletionMode, { removes: string[]; keeps: string[] }>;
  /** The company's grace option: a full scrub waits `DELETION_GRACE_DAYS`, with undo. */
  deletionGrace: boolean;
  /**
   * A scheduled scrub whose date has passed but which the rules now refuse: the daily
   * job leaves it waiting until `blockers` are sorted out.
   */
  scrubWaiting: boolean;
}

/** The facts behind the rules, read inside the caller's transaction (or on the pool for a preview). */
async function loadFacts(ex: Executor, companyId: string, person: PersonRow) {
  const [reports, pendingApprovals, admins] = await Promise.all([
    listReportsOf(ex, companyId, person.id),
    countPendingAssignedTo(ex, companyId, person.id),
    listActiveAdmins(ex, companyId),
  ]);
  return {
    person,
    reports: reports.map((r) => ({ id: r.id, name: personLabel(r) })),
    pendingApprovals,
    activeAdminIds: admins.map((a) => a.id),
  };
}

/**
 * Everything the delete dialog needs about one person: what blocks deleting them (still
 * active, people who report to them, pending requests waiting on them, the last admin),
 * and what each mode would remove, counted from the database.
 *
 * @throws DomainError `forbidden` (not an admin), `not_found` (another company's id, or
 *   someone already deleted), `no_company`.
 */
export async function getDeletionPreview(ctx: ServiceContext, actor: Actor, userId: string): Promise<DeletionPreview> {
  assertCanAdminister(actor);
  const [person, company] = await Promise.all([findPerson(ctx.db, actor.companyId, userId), findCompany(ctx.db, actor.companyId)]);
  if (!person) throw new DomainError("not_found");
  if (!company) throw new DomainError("no_company");
  const [facts, counts] = await Promise.all([loadFacts(ctx.db, actor.companyId, person), countDeletionFacts(ctx.db, actor.companyId, person.id)]);
  const blockers = deletionBlockers(facts);
  return {
    person,
    confirmName: confirmationTarget(person),
    blockers,
    blocked: isBlocked(blockers),
    counts,
    describe: { scrubbed: describeDeletion("scrubbed", counts), records_kept: describeDeletion("records_kept", counts) },
    deletionGrace: company.deletionGrace,
    scrubWaiting: person.scrubScheduledAt !== null && person.scrubScheduledAt.getTime() <= ctx.now().getTime() && isBlocked(blockers),
  };
}

/** What one delete did, as its audit row records it (`after.counts`). Counts only: never a name or email. */
export interface DeletionCountsDone {
  leaveRequestsDeleted: number;
  allowancesDeleted: number;
  auditEntriesDeleted: number;
  sessionsDeleted: number;
  accountsDeleted: number;
  verificationsDeleted: number;
  calendarFeedsDeleted: number;
  /** Their own requests still pending, withdrawn when records are kept (a scrub deletes them). */
  pendingRequestsWithdrawn: number;
  eventsRedacted: number;
  deliveriesRedacted: number;
  deliveriesFailed: number;
  importRunsRedacted: number;
  auditEntriesRedacted: number;
  notesRedacted: number;
  /** API key names, webhook descriptions and catalog names that mentioned them. */
  settingsRedacted: number;
}

export type DeletionOutcome =
  | { outcome: "deleted"; userId: string; mode: DeletionMode; tombstoneName: string; counts: DeletionCountsDone }
  | {
      outcome: "scheduled";
      userId: string;
      scheduledFor: Date;
      /** Whether it was scheduled before this call, which then changed nothing. */
      alreadyScheduled: boolean;
    };

/**
 * Replaces the person's name and email in everything stored that mentions them: outbox
 * payloads (and so what adapters are handed), webhook bodies and response excerpts, an
 * adapter's error text, import reports, the remaining audit snapshots, leave notes, and
 * the labels admins gave company settings (API key names, webhook descriptions,
 * department, leave type and holiday names).
 *
 * A webhook delivery whose body cannot be redacted safely (not JSON, or still holding the
 * email afterwards) is rewritten as plain text and, if still pending, stopped for good
 * (`failed`, `subject_deleted`), so it never sends their data. An attempt already in
 * flight with the old body or payload loses its outcome and runs again, redacted.
 */
async function redactStoredMentions(tx: Transaction, companyId: string, redactions: PersonRedaction, now: Date) {
  const needles = redactionNeedles(redactions);
  const done = {
    eventsRedacted: 0,
    deliveriesRedacted: 0,
    deliveriesFailed: 0,
    importRunsRedacted: 0,
    auditEntriesRedacted: 0,
    notesRedacted: 0,
    settingsRedacted: 0,
  };

  const redactedEvents: string[] = [];
  for (const event of await listEventsMentioning(tx, companyId, needles)) {
    const out = redactJson(event.payload, redactions);
    if (!out.changed) continue;
    await setEventPayload(tx, event.id, out.value);
    redactedEvents.push(event.id);
    done.eventsRedacted++;
  }
  await supersedeAdapterAttempts(tx, redactedEvents, now);

  for (const d of await listDeliveriesMentioning(tx, companyId, needles)) {
    const excerpt = d.lastResponseExcerpt === null ? null : redactText(d.lastResponseExcerpt, redactions);
    const body = redactJsonText(d.body, redactions);
    if (body === null) {
      const fail = d.status === "pending";
      await rewriteDelivery(tx, d.id, { body: redactText(d.body, redactions), lastResponseExcerpt: excerpt, fail, at: now });
      if (fail) done.deliveriesFailed++;
      else done.deliveriesRedacted++;
      continue;
    }
    if (!body.changed && excerpt === d.lastResponseExcerpt) continue;
    await rewriteDelivery(tx, d.id, { body: body.text, lastResponseExcerpt: excerpt, fail: false, at: now });
    done.deliveriesRedacted++;
  }

  for (const a of await listAdapterErrorsMentioning(tx, companyId, needles)) {
    const lastError = redactText(a.lastError ?? "", redactions);
    if (lastError !== a.lastError) await setAdapterError(tx, a.id, lastError);
  }

  for (const run of await listImportRunsMentioning(tx, companyId, needles)) {
    const report = redactJson(run.report, redactions);
    const counts = redactJson(run.counts, redactions);
    const sourceFileName = redactText(run.sourceFileName, redactions);
    if (!report.changed && !counts.changed && sourceFileName === run.sourceFileName) continue;
    await setImportRunText(tx, run.id, { report: report.value, counts: counts.value, sourceFileName });
    done.importRunsRedacted++;
  }

  for (const row of await listAuditMentioning(tx, companyId, needles)) {
    const before = redactJson(row.before, redactions);
    const after = redactJson(row.after, redactions);
    if (!before.changed && !after.changed) continue;
    await setAuditSnapshots(tx, row.id, { before: before.value, after: after.value });
    done.auditEntriesRedacted++;
  }

  for (const r of await listNotesMentioning(tx, companyId, needles)) {
    const note = r.note === null ? null : redactText(r.note, redactions);
    const decisionNote = r.decisionNote === null ? null : redactText(r.decisionNote, redactions);
    if (note === r.note && decisionNote === r.decisionNote) continue;
    await setNotes(tx, r.id, { note, decisionNote });
    done.notesRedacted++;
  }

  for (const label of await listSettingLabelsMentioning(tx, companyId, needles)) {
    const text = redactText(label.text, redactions);
    if (text === label.text) continue;
    await setSettingLabel(tx, label, text);
    done.settingsRedacted++;
  }
  return done;
}

/**
 * Every name the person is known by: their current one and any they had before a rename,
 * from their own events and the audit snapshots of their account. Read inside `tx`
 * before a scrub removes those audit rows.
 */
async function namesOf(tx: Transaction, companyId: string, person: PersonRow): Promise<string[]> {
  const owner = { id: person.id, email: person.email };
  const { events, accountSnapshots } = await listOwnNameRecords(tx, companyId, person.id);
  return [
    ...events.flatMap((payload) => namesInOwnRecords(payload, owner)),
    ...accountSnapshots.flatMap((snapshot) => namesInOwnRecords(snapshot, owner, true)),
  ];
}

/**
 * Carries out a delete inside `tx`, which must already hold the company lock and the
 * person's member lock, after the rules have passed. See the module comment for what
 * each mode removes. Writes the one `user.deleted` audit row and event last, attributed
 * to `source`.
 */
async function executeDeletion(
  tx: Transaction,
  input: { companyId: string; person: PersonRow; mode: DeletionMode; source: ChangeSource; now: Date },
): Promise<{ tombstoneName: string; counts: DeletionCountsDone }> {
  const { companyId, person, mode, source, now } = input;
  const signIn = await deleteSignInOf(tx, person);
  // The rules refuse anyone who still manages people; this only keeps a race from
  // leaving someone reporting to a tombstone.
  await clearManagerOf(tx, companyId, person.id);
  // A department manager is kept through deactivation (approvals skip them), but a
  // tombstone managing a department would still be named on it, so it is cleared here.
  // Nobody is re-routed: an inactive manager already approves nothing.
  for (const department of await clearDepartmentsManagedBy(tx, companyId, person.id)) {
    await recordChange(tx, {
      source,
      audit: {
        companyId,
        action: ADMIN_EVENT_TYPES.departmentManagerChanged,
        entityType: "department",
        entityId: department.id,
        subjectUserId: null,
        before: { managerId: person.id },
        after: { managerId: null },
      },
      event: {
        companyId,
        type: ADMIN_EVENT_TYPES.departmentManagerChanged,
        payload: { departmentId: department.id, name: department.name, managerId: null } satisfies Unattributed<DepartmentEventPayload>,
      },
    });
  }

  let leaveRequestsDeleted = 0;
  let allowancesDeleted = 0;
  let auditEntriesDeleted = 0;
  let pendingRequestsWithdrawn = 0;
  let formerNames: string[] = [];
  let namesInUse: string[] = [];
  if (mode === "scrubbed") {
    formerNames = await namesOf(tx, companyId, person);
    namesInUse = (await listOtherNames(tx, companyId, person.id)).map(nameInUse).filter((n): n is string => n !== null);
    leaveRequestsDeleted = await deleteLeaveRequestsOf(tx, companyId, person.id);
    allowancesDeleted = await deleteAllowancesOf(tx, person.id);
    auditEntriesDeleted = await deleteAuditAbout(tx, companyId, person.id);
  } else {
    // Their history stays, but a request still waiting would sit in Approvals for someone
    // who is gone, and hold up deleting its approver. The one `user.deleted` row counts it.
    pendingRequestsWithdrawn = await withdrawPendingRequestsOf(tx, companyId, person.id, now);
  }
  const redacted = await redactStoredMentions(tx, companyId, personRedactions(person, mode, formerNames, namesInUse), now);

  const name = tombstoneName(person, mode);
  await writeTombstone(tx, companyId, person.id, { name, email: tombstoneEmail(person.id), mode, at: now });

  const counts: DeletionCountsDone = {
    leaveRequestsDeleted,
    allowancesDeleted,
    auditEntriesDeleted,
    sessionsDeleted: signIn.sessions,
    accountsDeleted: signIn.accounts,
    verificationsDeleted: signIn.verifications,
    calendarFeedsDeleted: signIn.calendarFeeds,
    pendingRequestsWithdrawn,
    ...redacted,
  };
  const payload: Unattributed<UserDeletedPayload> = { userId: person.id, mode, deletedAt: now.toISOString() };
  await recordChange(tx, {
    source,
    audit: {
      companyId,
      action: ADMIN_EVENT_TYPES.userDeleted,
      entityType: "user",
      entityId: person.id,
      subjectUserId: person.id,
      before: null,
      after: { mode, counts },
    },
    event: { companyId, type: ADMIN_EVENT_TYPES.userDeleted, payload },
  });
  return { tombstoneName: name, counts };
}

/** Locks the company and checks the actor is still an active admin of it. */
async function beginAdminChange(tx: Transaction, actor: Actor): Promise<CompanyRow> {
  const company = await lockCompany(tx, actor.companyId);
  if (!company) throw new DomainError("no_company");
  await assertActiveAdmin(tx, actor);
  return company;
}

/**
 * Deletes a deactivated person, or, for a full scrub with the company's grace option on,
 * schedules it (`user.deletion_scheduled`; asking again while scheduled changes nothing).
 * Choosing to keep records runs at once, even when a scrub was scheduled.
 *
 * @param input.mode `scrubbed` or `records_kept`.
 * @param input.confirmName The person's full name, as the admin typed it.
 * @throws DomainError `forbidden`, `not_found` (another company's id, or already deleted),
 *   `invalid_input` (unknown mode), `confirmation_mismatch`, or `deletion_blocked` with
 *   its `blockers`: still active, manages people, has pending requests to decide, or is
 *   the last admin.
 */
export async function deletePerson(
  ctx: ServiceContext,
  actor: Actor,
  userId: string,
  input: { mode: string; confirmName: string },
): Promise<DeletionOutcome> {
  assertCanAdminister(actor);
  const mode = input.mode;
  if (!isDeletionMode(mode)) throw new DomainError("invalid_input", "Unknown delete mode.");
  return inTransaction(ctx, async (tx): Promise<DeletionOutcome> => {
    const company = await beginAdminChange(tx, actor);
    const person = await lockPerson(tx, actor.companyId, userId);
    if (!person) throw new DomainError("not_found");
    assertConfirmed(input.confirmName, person);
    assertDeletable(await loadFacts(tx, actor.companyId, person));
    const now = ctx.now();

    if (mode === "scrubbed" && company.deletionGrace) {
      if (person.scrubScheduledAt) return { outcome: "scheduled", userId: person.id, scheduledFor: person.scrubScheduledAt, alreadyScheduled: true };
      const scheduledFor = scrubDueAt(now);
      await scheduleScrub(tx, actor.companyId, person.id, { at: scheduledFor, requestedBy: actor.id });
      const payload: Unattributed<UserDeletionScheduleEventPayload> = { userId: person.id, scheduledFor: scheduledFor.toISOString() };
      await recordAdminChange(tx, actor, {
        type: ADMIN_EVENT_TYPES.userDeletionScheduled,
        entityType: "user",
        entityId: person.id,
        subjectUserId: person.id,
        before: null,
        after: { scheduledFor: scheduledFor.toISOString() },
        payload,
      });
      return { outcome: "scheduled", userId: person.id, scheduledFor, alreadyScheduled: false };
    }

    // Keeping records never waits; it replaces a scrub scheduled before.
    const done = await executeDeletion(tx, { companyId: actor.companyId, person, mode, source: actor.source, now });
    return { outcome: "deleted", userId: person.id, mode, ...done };
  });
}

/**
 * Clears a scheduled scrub inside `tx` and records it (`user.deletion_cancelled`). The
 * caller holds the company and member locks. @returns Whether one was scheduled.
 */
export async function cancelScheduledScrubIn(tx: Transaction, actor: Actor, person: PersonRow): Promise<boolean> {
  if (!person.scrubScheduledAt) return false;
  if (!(await clearScrubSchedule(tx, actor.companyId, person.id))) return false;
  const scheduledFor = person.scrubScheduledAt.toISOString();
  const payload: Unattributed<UserDeletionScheduleEventPayload> = { userId: person.id, scheduledFor };
  await recordAdminChange(tx, actor, {
    type: ADMIN_EVENT_TYPES.userDeletionCancelled,
    entityType: "user",
    entityId: person.id,
    subjectUserId: person.id,
    before: { scheduledFor },
    after: null,
    payload,
  });
  return true;
}

/**
 * Undoes a scheduled scrub: the person stays, deactivated. Doing it when nothing is
 * scheduled changes and records nothing.
 *
 * @returns Whether a scrub was scheduled (and now is not).
 * @throws DomainError `forbidden` or `not_found`.
 */
export async function cancelScheduledDeletion(ctx: ServiceContext, actor: Actor, userId: string): Promise<boolean> {
  assertCanAdminister(actor);
  return inTransaction(ctx, async (tx) => {
    await beginAdminChange(tx, actor);
    const person = await lockPerson(tx, actor.companyId, userId);
    if (!person) throw new DomainError("not_found");
    return cancelScheduledScrubIn(tx, actor, person);
  });
}

/** What one run of the scheduled-scrub job did. */
export interface ScrubRunResult {
  scrubbed: number;
  /**
   * Due scrubs a rule now refuses (say, someone reports to them again): left scheduled,
   * retried on the next run, and shown on the person's page with what blocks them.
   */
  blocked: number;
}

/**
 * The daily job's step: carries out every full scrub whose grace period has ended (at most
 * `limit`), each in its own transaction under the company lock and the person's member
 * lock, attributed to the system (`scheduled_scrub`) on behalf of the admin who asked.
 * The rules are checked again first; a scrub they now refuse is logged
 * (`scheduled_scrub_blocked`), left scheduled and passed over, so it never holds up the
 * ones due after it. A failure of one is logged and does not stop the others.
 */
export async function runDueScrubs(ctx: ServiceContext, options: { limit?: number } = {}): Promise<ScrubRunResult> {
  const now = ctx.now();
  const limit = options.limit ?? SCRUBS_PER_RUN;
  const result: ScrubRunResult = { scrubbed: 0, blocked: 0 };
  let checked = 0;
  let cursor: DueScrubCursor | undefined;
  while (result.scrubbed < limit && checked < SCRUB_CHECKS_PER_RUN) {
    const due = await listDueScrubs(ctx.db, now, Math.min(limit, SCRUB_CHECKS_PER_RUN - checked), cursor);
    if (due.length === 0) break;
    const last = due.at(-1)!;
    cursor = { at: last.scrubScheduledAt!, id: last.id };
    checked += due.length;
    for (const { id, companyId } of due) {
      if (result.scrubbed >= limit) break;
      if (!companyId) continue;
      const outcome = await runOneDueScrub(ctx, id, companyId, now);
      if (outcome === "scrubbed") result.scrubbed++;
      if (outcome === "blocked") result.blocked++;
    }
  }
  return result;
}

/** One due scrub, in its own transaction. Never throws: a failure is logged. */
type DueScrubOutcome = "scrubbed" | "blocked" | "gone" | "failed";

async function runOneDueScrub(ctx: ServiceContext, id: string, companyId: string, now: Date): Promise<DueScrubOutcome> {
  try {
    const outcome = await inTransaction(ctx, async (tx): Promise<DueScrubOutcome> => {
      if (!(await lockCompany(tx, companyId))) return "gone";
      const person = await lockPerson(tx, companyId, id);
      if (!person?.scrubScheduledAt || person.scrubScheduledAt.getTime() > now.getTime()) return "gone";
      const facts = await loadFacts(tx, companyId, person);
      if (isBlocked(deletionBlockers(facts))) return "blocked";
      const request = await findScrubRequest(tx, companyId, person.id);
      const source = bySystem(CHANGE_PROCESSES.scheduledScrub, request?.scrubRequestedBy ?? undefined);
      await executeDeletion(tx, { companyId, person, mode: "scrubbed", source, now });
      return "scrubbed";
    });
    if (outcome === "blocked") log.warn({ userId: id, companyId }, "scheduled_scrub_blocked");
    return outcome;
  } catch (err) {
    log.error({ userId: id, companyId, err }, "scheduled_scrub_failed");
    return "failed";
  }
}

const EXPORT_HEADER = [
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

type ExportRow = Partial<Record<(typeof EXPORT_HEADER)[number], CsvCell>>;

/** Most audit entries the export holds; a person with more gets the newest ones. */
const EXPORT_AUDIT_MAX = 10_000;

/**
 * A person's records as one CSV, for an admin to keep before deleting them: their leave
 * requests (with notes), their balance per leave type for every year they have an
 * allowance or booked leave, and the audit entries about them. One `record` column says
 * which kind each row is.
 *
 * Audited as `user.records_exported` (an audit row, no event: nothing changed). Once
 * downloaded, the file is outside OOOhm.
 *
 * @returns The file name (by the person's short id, never their name) and the CSV text.
 * @throws DomainError `forbidden`, `not_found` (another company's id, or someone deleted), `no_company`.
 */
export async function exportPersonRecords(ctx: ServiceContext, actor: Actor, userId: string): Promise<{ fileName: string; csv: string }> {
  assertCanAdminister(actor);
  const person = await inTransaction(ctx, async (tx) => {
    await assertActiveAdmin(tx, actor);
    const row = await findPerson(tx, actor.companyId, userId);
    if (!row) throw new DomainError("not_found");
    await recordAuditOnly(tx, {
      source: actor.source,
      audit: {
        companyId: actor.companyId,
        action: RECORDS_EXPORTED_AUDIT_ACTION,
        entityType: "user",
        entityId: row.id,
        subjectUserId: row.id,
        before: null,
        after: null,
      },
    });
    return row;
  });
  const company = await findCompany(ctx.db, actor.companyId);
  if (!company) throw new DomainError("no_company");

  const [requests, years, types] = await Promise.all([
    listRequestsForExport(ctx.db, actor.companyId, person.id),
    listRecordYears(ctx.db, actor.companyId, person.id),
    listLeaveTypesWithAllowance(ctx.db, actor.companyId),
  ]);
  const rows: ExportRow[] = requests.map((r) => ({
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

  if (years.length > 0 && types.length > 0) {
    const balanceOf = await loadBalances(ctx.db, { companyId: actor.companyId, allowancePolicy: company.allowancePolicy, leaveTypes: types, userIds: [person.id], years }).catch(
      (err: unknown) => {
        log.error({ err, companyId: actor.companyId }, "allowance_policy_unavailable");
        return null;
      },
    );
    for (const year of balanceOf ? years : []) {
      for (const type of types) {
        const b = balanceOf!(person.id, type.id, year);
        if (b.used === 0 && b.pending === 0 && (!b.tracked || (b.allowance === 0 && b.carriedOver === 0 && b.adjustment === 0))) continue;
        rows.push({
          record: "balance",
          leave_type: type.name,
          year,
          used: b.used,
          pending: b.pending,
          ...(b.tracked
            ? { allowance: b.allowance, carried_over: b.carriedOver, adjustment: b.adjustment, total: b.total, carried_out: b.carriedOut, remaining: b.remaining }
            : { allowance: "unlimited" }),
        });
      }
    }
  }

  for (const e of await listAuditEntriesAbout(ctx, actor, person.id, EXPORT_AUDIT_MAX)) {
    rows.push({ record: "audit", id: e.id, date: e.at.toISOString(), action: e.label, by: e.actorLabel, changes: e.changes.join("; ") });
  }

  return {
    fileName: `ooohm-records-${shortStableId(person.id)}.csv`,
    csv: toCsv(EXPORT_HEADER, rows.map((r) => EXPORT_HEADER.map((h) => r[h]))),
  };
}
