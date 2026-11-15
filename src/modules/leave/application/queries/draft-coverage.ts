import "server-only";
import type { Executor } from "@/db/types";
import { findDepartment } from "@/modules/organisation";
import { findPerson } from "@/shared/lib/db/members";
import { alsoOffFor } from "./also-off";

/**
 * The coverage warning for a draft of `userId`'s, for the request form's live preview:
 * the same line their approver would read ({@link alsoOffFor}), or `null` when it stays
 * within their department's limit, or they have no department or it has no limit.
 */
export async function draftCoverage(
  ex: Executor,
  companyId: string,
  userId: string,
  draft: { startDate: string; endDate?: string | null | undefined },
): Promise<string | null> {
  const person = await findPerson(ex, companyId, userId);
  const department = person?.departmentId ? await findDepartment(ex, companyId, person.departmentId) : undefined;
  if (!department || department.maxOff === null) return null;
  const request = {
    id: "draft",
    userId,
    departmentId: department.id,
    departmentName: department.name,
    startDate: draft.startDate,
    endDate: draft.endDate || draft.startDate,
  };
  return (await alsoOffFor(ex, companyId, [request])).get("draft")?.coverage ?? null;
}
