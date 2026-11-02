import { toActor } from "@/domain/actor";
import { canAdminister } from "@/domain/admin-permissions";
import { isDomainError } from "@/domain/errors";
import { currentUser } from "@/lib/auth";
import { isCrossSiteRequest } from "@/lib/fetch-site";
import { log } from "@/lib/log";
import { serviceContext } from "@/server/runtime";
import { exportPersonRecords } from "@/server/services/admin-people-deletion";

/** Personal data: never stored by a browser or a proxy. */
const PRIVATE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

function bare(status: number): Response {
  return new Response(null, { status, headers: PRIVATE });
}

/**
 * `GET /admin/people/<id>/export`: a person's records as CSV (their leave requests,
 * balances per year and the audit entries about them), for an admin to keep before
 * deleting them. Admins of the person's company only: anyone else, and an id of another
 * company or of someone deleted, gets a bare 404, as the admin pages do. Each download is
 * audited (`user.records_exported`).
 *
 * A GET that writes an audit row and downloads personal data, so it answers only a
 * request from OOOhm's own pages or one the admin typed (`Sec-Fetch-Site` `same-origin`
 * or `none`): another site sending a signed-in admin's browser here gets a 404, and
 * nothing is downloaded or recorded.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  if (isCrossSiteRequest(request.headers)) return bare(404);
  const user = await currentUser();
  if (!user) return bare(401);
  const actor = toActor(user);
  if (!actor || !canAdminister(actor)) return bare(404);
  const { id } = await ctx.params;
  if (id.length === 0 || id.length > 100) return bare(404);

  try {
    const { fileName, csv } = await exportPersonRecords(serviceContext(), actor, id);
    return new Response(csv, {
      headers: {
        ...PRIVATE,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"`,
      },
    });
  } catch (err) {
    if (isDomainError(err, "not_found") || isDomainError(err, "forbidden")) return bare(404);
    log.error({ err }, "person_export_failed");
    return bare(500);
  }
}
