# people

**Tier 2.** Everyone in a company and their lifecycle: Admin → People (invite, edit, deactivate, reactivate,
delete with its grace period, the records export, the CSV import), the teammate page, and a person's own account
(name, colour mode, passkeys). Admins only for everything under Admin → People (`canManagePeople`,
`canDeletePeople`, `canImportPeople`); each use case refuses anyone else with `forbidden` before it reads.

People sits near the top of the module graph: it imports approvals (re-routing after a manager change), balances,
calendar (feeds revoked on deactivation, the scope for the teammate page), leave, integrations (live API keys and
endpoints in the deletion preview), organisation, audit and notifications. Nothing below it imports people. The
member directory those modules read (`findMember`, `lockMember`, `listActiveAdmins`, …) is
`src/shared/lib/db/members.ts`, not this module, so they never need to.

## Owns

- The admin writes to `user` (`infrastructure/drizzle-people.repository.ts`: the people list, reporting lines,
  email checks, colour mode, sign-outs). The plain member reads and `insertPerson` / `updatePerson` are in
  `src/shared/lib/db/members.ts`.
- `passkey` reads and deletes (`infrastructure/drizzle-passkeys.repository.ts`).
- Person deletion (`infrastructure/drizzle-person-deletion.repository.ts`): the facts the preview shows, the
  history it removes, and the redaction of stored mentions (`drizzle-mention-store.ts` implements the
  `MentionStore` port in `application/deletion/mention-store.ts`).

Every change writes an audit row and a `user.*` event in the same transaction (`application/person-changes.ts`,
through `recordAdminChange`).

## Deletion lifecycle

Active → deactivated → deleted. Deleting in `scrubbed` mode removes the person's history now; in `records_kept`
mode the row is tombstoned and the scrub is scheduled `DELETION_GRACE_DAYS` ahead (`domain/deletion-lifecycle.ts`
decides which). `cancelScheduledDeletion` undoes a schedule; the daily scheduled job runs due scrubs through
`runDueScrubs` (`sweepDueScrubs` pages them oldest first and stops after `SCRUB_CHECKS_PER_RUN` looked at, so
blocked ones cannot make a run endless). A scrub erases the person's audit rows only through the owner's
`SECURITY DEFINER` function `ooohm_erase_audit_about` (drizzle/0030): the app role cannot change audit rows
any other way.

## Public API (`index.ts`)

Queries and use cases that can fail return a `ServiceResult`.

- Admin → People: `listPeople`, `getPersonFormOptions`, `getPersonDetail`, `invitePerson`, `resendInvite`,
  `updatePerson`, `deactivatePerson`, `reactivatePerson`, and the invite limits.
- Deletion: `getDeletionPreview`, `deletePerson` (`deletionBlockersOf` reads the blockers off a refusal),
  `cancelScheduledDeletion`, `exportPersonRecords`, `runDueScrubs` (for `src/server/jobs`), `DELETION_MODES`,
  `DELETION_GRACE_DAYS`.
- Import: `previewPeopleImport`, `importPeople`, its limits and sample CSV.
- `getTeamMember` (the teammate page; `not_found` for an id that is not a uuid or not visible).
- Account: `getAccount`, `hasPasskey`, `renameSelf`, `setColorMode`.
- `recordPersonCreated`, a step on the first install's transaction (`src/server/identity/install.ts`).
- DTOs only (`PersonDTO`, `PersonListItemDTO`, `PasskeyDTO`, `AccountDTO`, …): never a row, a passkey's key or
  its backup flag.

## Inside

- `application/use-cases/`, `application/queries/`, `application/steps/`: one function per file.
  `application/deletion/` holds the deletion's parts (facts, execution, scheduling, redaction, the export rows).
- `domain/`: `people.ts` (roles, manager and last-admin rules), `person-deletion.ts`, `deletion-lifecycle.ts`,
  `people-import.ts`. The name and email normalizers, `personLabel` / `teamLabel` and the CSV helpers are in
  `src/shared/kernel` (`names.ts`, `person-label.ts`, `csv.ts`) because client components, organisation and the
  install use them too.

## Tests

`tests/unit/modules/people/` (domain, DTOs, policies, the refusals before any read, redaction on an in-memory
store, the scrub sweep on fakes) and the integration suites for people, deletion, import and account.
