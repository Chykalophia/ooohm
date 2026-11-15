import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { DomainError } from "@/shared/kernel/errors";
import { RECORDS_EXPORTED_AUDIT_ACTION } from "@/shared/kernel/events";
import type { ServiceContext } from "@/server/context";
import { findCompany } from "@/modules/organisation";
import { auditRows, balanceRows, EXPORT_HEADER, requestRows } from "@/modules/people/application/deletion/records-export";
import { canDeletePeople } from "@/modules/people/application/policies";
import { shortStableId } from "@/modules/people/domain/person-deletion";
import { assertActiveAdmin } from "@/shared/lib/admin-access";
import { recordAuditOnly } from "@/shared/lib/db/change-log";
import { findPerson } from "@/shared/lib/db/members";
import { toCsv } from "@/shared/kernel/csv";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { inTransaction } from "@/shared/lib/unit-of-work";

/**
 * A person's records as one CSV, for an admin to keep before deleting them: their leave
 * requests (with notes), their balance per leave type for every year they have an
 * allowance or booked leave, and the audit entries about them. One `record` column says
 * which kind each row is.
 *
 * Audited as `user.records_exported` (an audit row, no event: nothing changed). Once
 * downloaded, the file is outside OOOhm.
 *
 * @returns The file name (by the person's short id, never their name) and the CSV text.
 *   Fails with `forbidden`, `not_found` (another company's id, or someone deleted), or `no_company`.
 */
export async function exportPersonRecords(ctx: ServiceContext, actor: Actor, userId: string): Promise<ServiceResult<{ fileName: string; csv: string }>> {
  if (!canDeletePeople(actor)) return err("forbidden");
  return attempt(async () => {
    const personId = await recordExport(ctx, actor, userId);
    const company = await findCompany(ctx.db, actor.companyId);
    if (!company) throw new DomainError("no_company");
    const rows = [
      ...(await requestRows(ctx.db, actor.companyId, personId)),
      ...(await balanceRows(ctx.db, company, personId)),
      ...(await auditRows(ctx, actor, personId)),
    ];
    return {
      fileName: `ooohm-records-${shortStableId(personId)}.csv`,
      csv: toCsv(EXPORT_HEADER, rows.map((r) => EXPORT_HEADER.map((h) => r[h]))),
    };
  });
}

/** Checks the admin and the person, and writes the export's audit row. @returns The person's id. */
async function recordExport(ctx: ServiceContext, actor: Actor, userId: string): Promise<string> {
  return inTransaction(ctx, async (tx) => {
    await assertActiveAdmin(tx, actor);
    const row = await findPerson(tx, actor.companyId, userId);
    if (!row) throw new DomainError("not_found");
    await recordAuditOnly(tx, {
      source: actor.source,
      audit: {
        companyId: actor.companyId,
        action: RECORDS_EXPORTED_AUDIT_ACTION,
        entityType: "user",
        entityId: row.id,
        subjectUserId: row.id,
        before: null,
        after: null,
      },
    });
    return row.id;
  });
}
