import { type EmailCopy, unknownVariables } from "@/domain/email-template";
import { log } from "@/lib/log";
import type { ServiceContext } from "@/server/context";
import { listEmailTemplates } from "@/server/repositories/email-templates";
import { isNotificationKind, NOTIFICATION_TYPES, type NotificationKind } from "./catalog";

/** The variable names a type's copy may use. */
export function variableNames(kind: NotificationKind): string[] {
  return NOTIFICATION_TYPES[kind].copy.variables.map((v) => v.name);
}

/**
 * Saved copy as it may be sent: a field naming a variable the email no longer has (copy
 * saved before a variable was withdrawn) falls back to the default rather than send a gap.
 */
export function usableCopy(kind: NotificationKind, saved: EmailCopy): EmailCopy {
  const names = variableNames(kind);
  const usable = (field: string | null) => (field !== null && unknownVariables(field, names).length === 0 ? field : null);
  return { subject: usable(saved.subject), message: usable(saved.message) };
}

/**
 * The company's own words for each email, read once on first use and shared by every
 * email built from the returned function. Called after commit, so it reads through
 * `ctx.db`. It never throws: if the copy cannot be read, emails go out in their default
 * words rather than not at all.
 */
export function emailCopyFor(ctx: ServiceContext, companyId: string): (kind: NotificationKind) => Promise<EmailCopy | null> {
  let all: Promise<Map<NotificationKind, EmailCopy>> | undefined;
  const read = () =>
    (all ??= listEmailTemplates(ctx.db, companyId).then(
      (rows) => new Map(rows.filter((r) => isNotificationKind(r.type)).map((r) => [r.type as NotificationKind, usableCopy(r.type as NotificationKind, r)])),
      (err: unknown) => {
        log.warn({ err }, "email_copy_read_failed");
        return new Map();
      },
    ));
  return async (kind) => (await read()).get(kind) ?? null;
}
