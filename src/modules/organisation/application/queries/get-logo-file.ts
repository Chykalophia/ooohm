import "server-only";
import { parseLogoFile } from "@/domain/company-logo";
import type { ServiceContext } from "@/server/context";
import { findLogoFile } from "@/modules/organisation/infrastructure/drizzle-companies.repository";

/**
 * The stored logo a URL names (`<sha256>.<ext>`), or null when none is stored under it
 * with that type. Public, like the favicon: a logo is shown before sign-in and in emails.
 */
export async function getLogoFile(ctx: ServiceContext, file: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const wanted = parseLogoFile(file);
  if (!wanted) return null;
  const found = await findLogoFile(ctx.db, wanted.sha256);
  return found && found.contentType === wanted.contentType ? found : null;
}
