import "server-only";
/**
 * The notifications module's public API (see README.md): every email a change sends, and
 * the email editor (Admin → Emails). Everything outside the module imports from here only.
 */
export { commitThenNotify } from "./application/commit-then-notify";
export type { Notification } from "./application/catalog";
export type { LeaveSummary } from "./application/templates/leave";
export { listEmailsForAdmin } from "./application/queries/list-emails-for-admin";
export { getEmailForAdmin } from "./application/queries/get-email-for-admin";
export { previewEmail } from "./application/queries/preview-email";
export { saveEmailCopy } from "./application/use-cases/save-email-copy";
export { resetEmailCopy } from "./application/use-cases/reset-email-copy";
export { canEditEmailCopy } from "./application/policies";
export type { EmailEditorDTO, EmailListItemDTO, EmailPreviewDTO } from "./application/dto";
