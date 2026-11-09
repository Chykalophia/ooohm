import { log } from "@/lib/log";
import type { ServiceContext } from "@/server/context";
import { DEFAULT_EMAIL_ACCENT, type EmailAccent, emailAccent } from "@/lib/email-layout";
import { findCompany } from "@/server/repositories/companies";

/**
 * The company's email look (accent and logo), read once on first use and shared by every email built
 * from the returned function. Called after commit, so it reads through `ctx.db`. It
 * never throws: if the company cannot be read, the email goes out in the default teal, with the OOOhm wordmark,
 * rather than not at all.
 */
export function emailAccentFor(ctx: ServiceContext, companyId: string): () => Promise<EmailAccent> {
  let accent: Promise<EmailAccent> | undefined;
  return () =>
    (accent ??= findCompany(ctx.db, companyId).then((company) => emailAccent(company, ctx.appUrl), (err: unknown) => {
      log.warn({ err }, "email_accent_read_failed");
      return DEFAULT_EMAIL_ACCENT;
    }));
}
