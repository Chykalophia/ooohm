import { and, eq } from "drizzle-orm";
import { emailTemplates } from "@/db/schema";
import type { Executor } from "@/db/types";

export interface EmailTemplateRow {
  type: string;
  subject: string | null;
  message: string | null;
  updatedAt: Date;
}

const fields = {
  type: emailTemplates.type,
  subject: emailTemplates.subject,
  message: emailTemplates.message,
  updatedAt: emailTemplates.updatedAt,
};

/** Every email the company has its own words for. */
export async function listEmailTemplates(ex: Executor, companyId: string): Promise<EmailTemplateRow[]> {
  return ex.select(fields).from(emailTemplates).where(eq(emailTemplates.companyId, companyId));
}

export async function findEmailTemplate(ex: Executor, companyId: string, type: string): Promise<EmailTemplateRow | undefined> {
  const [row] = await ex
    .select(fields)
    .from(emailTemplates)
    .where(and(eq(emailTemplates.companyId, companyId), eq(emailTemplates.type, type)));
  return row;
}

/** Saves the company's words for `type`; at least one of `subject` and `message` is set. */
export async function upsertEmailTemplate(
  ex: Executor,
  companyId: string,
  type: string,
  copy: { subject: string | null; message: string | null },
): Promise<EmailTemplateRow> {
  const [row] = await ex
    .insert(emailTemplates)
    .values({ companyId, type, ...copy })
    .onConflictDoUpdate({ target: [emailTemplates.companyId, emailTemplates.type], set: { ...copy, updatedAt: new Date() } })
    .returning(fields);
  return row;
}

/** Removes the company's words for `type`, so the email goes back to its defaults. */
export async function deleteEmailTemplate(ex: Executor, companyId: string, type: string): Promise<EmailTemplateRow | undefined> {
  const [row] = await ex
    .delete(emailTemplates)
    .where(and(eq(emailTemplates.companyId, companyId), eq(emailTemplates.type, type)))
    .returning(fields);
  return row;
}
