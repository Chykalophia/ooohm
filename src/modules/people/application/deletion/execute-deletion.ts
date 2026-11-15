import "server-only";
/**
 * Carries out a delete, after the rules have passed:
 *
 * - **Full scrub** (`scrubbed`): nothing about them remains. Their requests, allowances
 *   and the audit entries about them are deleted, their name and email are redacted from
 *   every stored payload, and their row becomes "Former employee #<id>".
 * - **Keep records** (`records_kept`): their sign-in and email go; their history stays
 *   under "<Name> (deleted)", and the email can be invited again as a new account.
 *
 * The `user` row is never removed: it stays as a tombstone so every foreign key holds.
 * Either delete writes exactly one audit row (`user.deleted`, `after` = mode and counts)
 * and one `user.deleted` event, neither with a name or email. Audit rows are deleted and
 * rewritten only through the database owner's functions (drizzle/0030).
 */
import type { Transaction } from "@/db/types";
import type { ChangeSource } from "@/domain/change-source";
import { ADMIN_EVENT_TYPES, type DeletionMode, type DepartmentEventPayload, type Unattributed, type UserDeletedPayload } from "@/domain/events";
import { clearDepartmentsManagedBy } from "@/modules/organisation";
import { nameInUse, namesInOwnRecords, personRedactions, tombstoneEmail, tombstoneName } from "@/modules/people/domain/person-deletion";
import { drizzleMentionStore } from "@/modules/people/infrastructure/drizzle-mention-store";
import {
  clearManagerOf,
  deleteAllowancesOf,
  deleteAuditAbout,
  deleteLeaveRequestsOf,
  deleteSignInOf,
  listOtherNames,
  listOwnNameRecords,
  withdrawPendingRequestsOf,
  writeTombstone,
} from "@/modules/people/infrastructure/drizzle-person-deletion.repository";
import { recordChange } from "@/shared/lib/db/change-log";
import type { PersonRow } from "@/shared/lib/db/members";
import { type RedactionCounts, redactStoredMentions } from "./redact-stored-mentions";

/** What one delete did, as its audit row records it (`after.counts`). Counts only: never a name or email. */
export interface DeletionCountsDone extends RedactionCounts {
  leaveRequestsDeleted: number;
  allowancesDeleted: number;
  auditEntriesDeleted: number;
  sessionsDeleted: number;
  accountsDeleted: number;
  verificationsDeleted: number;
  calendarFeedsDeleted: number;
  /** Their own requests still pending, withdrawn when records are kept (a scrub deletes them). */
  pendingRequestsWithdrawn: number;
}

export interface DeletionInput {
  companyId: string;
  person: PersonRow;
  mode: DeletionMode;
  source: ChangeSource;
  now: Date;
}

/**
 * Runs the delete inside `tx`, which must already hold the company lock and the
 * person's member lock. Writes the one `user.deleted` audit row and event last,
 * attributed to `source`.
 */
export async function executeDeletion(tx: Transaction, input: DeletionInput): Promise<{ tombstoneName: string; counts: DeletionCountsDone }> {
  const { companyId, person, mode, now } = input;
  const signIn = await deleteSignInOf(tx, person);
  await releaseManagement(tx, input);
  const history = await removeHistory(tx, input);
  const redactions = personRedactions(person, mode, history.formerNames, history.namesInUse);
  const redacted = await redactStoredMentions(drizzleMentionStore(tx, companyId), redactions, now);

  const name = tombstoneName(person, mode);
  await writeTombstone(tx, companyId, person.id, { name, email: tombstoneEmail(person.id), mode, at: now });
  const counts: DeletionCountsDone = {
    leaveRequestsDeleted: history.leaveRequestsDeleted,
    allowancesDeleted: history.allowancesDeleted,
    auditEntriesDeleted: history.auditEntriesDeleted,
    sessionsDeleted: signIn.sessions,
    accountsDeleted: signIn.accounts,
    verificationsDeleted: signIn.verifications,
    calendarFeedsDeleted: signIn.calendarFeeds,
    pendingRequestsWithdrawn: history.pendingRequestsWithdrawn,
    ...redacted,
  };
  await recordDeletion(tx, input, counts);
  return { tombstoneName: name, counts };
}

/**
 * The rules refuse anyone who still manages people; clearing their reports only keeps a
 * race from leaving someone reporting to a tombstone. A department manager is kept
 * through deactivation (approvals skip them), but a tombstone managing a department
 * would still be named on it, so it is cleared and recorded. Nobody is re-routed: an
 * inactive manager already approves nothing.
 */
async function releaseManagement(tx: Transaction, { companyId, person, source }: DeletionInput): Promise<void> {
  await clearManagerOf(tx, companyId, person.id);
  for (const department of await clearDepartmentsManagedBy(tx, companyId, person.id)) {
    const payload: Unattributed<DepartmentEventPayload> = { departmentId: department.id, name: department.name, managerId: null, maxOff: department.maxOff };
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
      event: { companyId, type: ADMIN_EVENT_TYPES.departmentManagerChanged, payload },
    });
  }
}

/**
 * A scrub deletes their requests, allowances and the audit entries about them, after
 * reading every name they had (for the free-text redaction) and the names others go by
 * (which it must leave alone). Keeping records withdraws only their pending requests:
 * one still waiting would sit in Approvals for someone who is gone.
 */
async function removeHistory(tx: Transaction, { companyId, person, mode, now }: DeletionInput) {
  const done = { leaveRequestsDeleted: 0, allowancesDeleted: 0, auditEntriesDeleted: 0, pendingRequestsWithdrawn: 0, formerNames: [] as string[], namesInUse: [] as string[] };
  if (mode !== "scrubbed") return { ...done, pendingRequestsWithdrawn: await withdrawPendingRequestsOf(tx, companyId, person.id, now) };
  done.formerNames = await namesOf(tx, companyId, person);
  done.namesInUse = (await listOtherNames(tx, companyId, person.id)).map(nameInUse).filter((n): n is string => n !== null);
  done.leaveRequestsDeleted = await deleteLeaveRequestsOf(tx, companyId, person.id);
  done.allowancesDeleted = await deleteAllowancesOf(tx, person.id);
  done.auditEntriesDeleted = await deleteAuditAbout(tx, companyId, person.id);
  return done;
}

/**
 * Every name the person is known by: their current one and any they had before a rename,
 * from their own events and the audit snapshots of their account. Read before a scrub
 * removes those audit rows.
 */
async function namesOf(tx: Transaction, companyId: string, person: PersonRow): Promise<string[]> {
  const owner = { id: person.id, email: person.email };
  const { events, accountSnapshots } = await listOwnNameRecords(tx, companyId, person.id);
  return [
    ...events.flatMap((payload) => namesInOwnRecords(payload, owner)),
    ...accountSnapshots.flatMap((snapshot) => namesInOwnRecords(snapshot, owner, true)),
  ];
}

/** The one `user.deleted` audit row and event. */
async function recordDeletion(tx: Transaction, { companyId, person, mode, source, now }: DeletionInput, counts: DeletionCountsDone): Promise<void> {
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
}
