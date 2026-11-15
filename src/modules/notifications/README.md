# notifications

**Tier 2.** Every email a change sends, and the email editor (Admin → Emails) where an admin replaces an email's
subject and message with the company's own words.

## Owns

The `email_templates` table (`infrastructure/drizzle-email-templates.repository.ts`). Only this module writes it.

## Public API (`index.ts`)

- `commitThenNotify(ctx, companyId, work)`: runs `work` in a transaction (`commitThen` in
  `src/shared/lib/unit-of-work.ts`), then sends the notifications it returned. The only way services send mail.
- Types `Notification` (a type, a recipient and its data) and `LeaveSummary` (the request a leave email describes).
- `listEmailsForAdmin(ctx, actor)` → `ServiceResult<EmailListItemDTO[]>`: fails with `forbidden`.
- `getEmailForAdmin(ctx, actor, type)` → `ServiceResult<EmailEditorDTO>`: also `not_found`.
- `previewEmail(ctx, actor, type, draft)` → `ServiceResult<EmailPreviewDTO>`: also `invalid_input` (with the field).
  Saves and sends nothing.
- `saveEmailCopy(ctx, actor, type, input)` → `ServiceResult<EmailCopy>`: also `no_company`. Records
  `email_template.updated` (or `.reset` when both fields are the defaults); saving what is saved records nothing.
- `resetEmailCopy(ctx, actor, type)` → `ServiceResult<void>`: records `email_template.reset` when there was copy.
- `canEditEmailCopy(actor)`: admins only.
- Types `EmailListItemDTO`, `EmailEditorDTO`, `EmailPreviewDTO`.

Every copy change writes an audit row and an outbox event in its transaction, through `recordAdminChange`.

## Inside

- `application/catalog.ts`: every notification type, its build function, its editable copy and preview sample.
- `application/templates/`: the pure renderers (`leave.ts`, `invite.ts`, `copy.ts`, `content.ts`). Lint keeps them
  pure: no database, configuration, session, framework, service or module import; they import each other as `./x`.
- `application/send.ts` (after-commit sender), `accent.ts` (the company accent), `copy.ts` (the company's saved
  words), `preview.ts`, `types.ts`, `commit-then-notify.ts`.
- `application/queries/`, `application/use-cases/`, `application/email-editor.ts` (the rules they share),
  `policies.ts`, `dto.ts`.
- `tests/unit/email-output.test.ts` pins every email's output.
