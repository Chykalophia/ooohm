import "server-only";
/**
 * The people module's public API (see README.md): the admin people screens (list,
 * invite, edit, deactivate, reactivate, delete with its grace period, the records export,
 * the CSV import), the signed-in person's own account, and the daily scrub job.
 * Everything outside the module imports from here only.
 */

// Admin: people.
export { listPeople, PEOPLE_PAGE_SIZE } from "./application/queries/list-people";
export { getPersonFormOptions } from "./application/queries/get-person-form-options";
export { getPersonDetail } from "./application/queries/get-person-detail";
export { invitePerson } from "./application/use-cases/invite-person";
export { resendInvite } from "./application/use-cases/resend-invite";
export { updatePerson } from "./application/use-cases/update-person";
export { deactivatePerson } from "./application/use-cases/deactivate-person";
export { reactivatePerson } from "./application/use-cases/reactivate-person";
export { INVITE_LIMIT, INVITE_WINDOW_MINUTES } from "./application/admin-change";

// Admin: deleting a person.
export { getDeletionPreview } from "./application/queries/get-deletion-preview";
export { deletePerson } from "./application/use-cases/delete-person";
export { cancelScheduledDeletion } from "./application/use-cases/cancel-scheduled-deletion";
export { exportPersonRecords } from "./application/use-cases/export-person-records";
export { runDueScrubs, SCRUBS_PER_RUN } from "./application/use-cases/run-due-scrubs";
export { DELETION_GRACE_DAYS, DELETION_MODES, deletionBlockersOf } from "./domain/person-deletion";

// Admin: the CSV import.
export { previewPeopleImport } from "./application/queries/preview-people-import";
export { importPeople, PEOPLE_IMPORT_HOURLY_LIMIT, PEOPLE_IMPORT_WINDOW_MINUTES } from "./application/use-cases/import-people";
export { PEOPLE_IMPORT_MAX_ROWS, peopleImportSampleCsv } from "./domain/people-import";

// The signed-in person's own account.
export { getAccount } from "./application/queries/get-account";
export { hasPasskey } from "./application/queries/has-passkey";
export { renameSelf } from "./application/use-cases/rename-self";
export { setColorMode } from "./application/use-cases/set-color-mode";

// A step for other code's transaction.
export { recordPersonCreated } from "./application/steps/record-person-created";

export { canDeletePeople, canImportPeople, canManagePeople } from "./application/policies";

export type { AccountDTO, PasskeyDTO, PersonDTO, PersonListItemDTO } from "./application/dto";
export type { InviteInput, PersonInput } from "./application/person-input";
export type { PeopleListFilter, PeoplePageDTO } from "./application/queries/list-people";
export type { PersonFormOptionsDTO } from "./application/queries/get-person-form-options";
export type { PersonDetailDTO } from "./application/queries/get-person-detail";
export type { PersonUpdateResult } from "./application/use-cases/update-person";
export type { DeactivationResult } from "./application/use-cases/deactivate-person";
export type { DeletionPreview } from "./application/queries/get-deletion-preview";
export type { DeletionOutcome } from "./application/use-cases/delete-person";
export type { DeletionCountsDone } from "./application/deletion/execute-deletion";
export type { ScrubRunResult } from "./application/use-cases/run-due-scrubs";
export type { PeopleImportPreview } from "./application/people-import-plan";
export type { PeopleImportResult } from "./application/use-cases/import-people";
export type { DeletionBlockers, DeletionMode } from "./domain/person-deletion";
export type { PeopleImportPlan } from "./domain/people-import";
