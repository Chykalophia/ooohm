import "server-only";
import type { Actor } from "@/domain/actor";
import type { ServiceContext } from "@/server/context";
import { type PeopleImportPreview, planPeopleFile } from "@/modules/people/application/people-import-plan";
import { canImportPeople } from "@/modules/people/application/policies";
import { assertActiveAdmin } from "@/shared/lib/admin-access";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";

/**
 * What importing `csv` would do, row by row. Writes nothing.
 *
 * Fails with `forbidden` (not an active admin), or `invalid_input` with a message to
 * show when the file cannot be read as an import file.
 */
export async function previewPeopleImport(ctx: ServiceContext, actor: Actor, csv: string): Promise<ServiceResult<PeopleImportPreview>> {
  if (!canImportPeople(actor)) return err("forbidden");
  return attempt(async () => {
    await assertActiveAdmin(ctx.db, actor);
    return planPeopleFile(ctx.db, actor.companyId, csv);
  });
}
