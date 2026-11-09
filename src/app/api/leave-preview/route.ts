import type { NextRequest } from "next/server";
import { toActor } from "@/domain/actor";
import { isDomainError } from "@/domain/errors";
import { currentUser } from "@/lib/auth";
import { formatRequestCost } from "@/lib/format";
import { log } from "@/lib/log";
import { createRateLimiter } from "@/lib/rate-limit";
import { serviceContext } from "@/server/runtime";
import { previewLeaveRequest } from "@/server/services/balances";
import { previewLeaveFor } from "@/server/services/leave-on-behalf";
import { draftCoverage } from "@/server/services/also-off";
import { type LeavePreviewResponse, leaveDraftSchema, readDraftFields } from "@/app/_lib/leave-input";
import { addForMessages } from "@/app/_lib/leave-for-messages";
import { messageFor, messageForError } from "@/app/_lib/run-action";

/**
 * Previews per person per minute. The form asks at most once per 300 ms pause, so
 * this only stops a script hammering the endpoint (and, with a misconfigured policy,
 * the error log). Submit has its own database-backed limit.
 */
const PREVIEWS_PER_MINUTE = 60;
const previewLimiter = createRateLimiter({ limit: PREVIEWS_PER_MINUTE, windowMs: 60_000 });

function reply(body: LeavePreviewResponse, status = 200): Response {
  // Personal balance data: never cached by a browser or a proxy.
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

/**
 * Live preview for the request form: `GET /api/leave-preview?leaveTypeId=&startDate=&endDate=&dayPortion=`,
 * plus `&for=<user id>` on a teammate's page, where a manager or admin adds time off for them
 * (`previewLeaveFor`).
 *
 * Runs the same service computation as submit (`assessLeaveRequest`) for the signed-in
 * person and answers with what the request would cost and leave, or the calm message
 * submit would show. When the dates take the person's department over its coverage
 * limit, the warning follows (`draftCoverage`); it never stops the request. Writes nothing. A route handler rather than a server action,
 * because Next.js runs a client's server actions one at a time and this read must
 * never queue behind (or in front of) a submit. Limited to {@link PREVIEWS_PER_MINUTE}
 * per person per minute (429 beyond that).
 */
export async function GET(request: NextRequest): Promise<Response> {
  const user = await currentUser();
  if (!user) return reply({ ok: false, message: "Your session has ended. Sign in again." }, 401);
  const actor = toActor(user);
  if (!actor) return reply({ ok: false, message: messageFor("no_company") }, 403);
  if (!previewLimiter.take(actor.id)) return reply({ ok: false, message: messageFor("rate_limited") }, 429);

  const parsed = leaveDraftSchema.safeParse(readDraftFields(request.nextUrl.searchParams));
  if (!parsed.success) return reply({ ok: false, message: messageFor("invalid_input") }, 400);

  const forUserId = request.nextUrl.searchParams.get("for");
  const ctx = serviceContext();
  // A department over its coverage limit only ever warns: the warning follows the cost.
  // It is advisory, so a failed lookup keeps the cost line rather than failing the preview.
  const withCoverage = async (message: string, userId: string) => {
    try {
      const coverage = await draftCoverage(ctx.db, actor.companyId, userId, parsed.data);
      return coverage ? `${message} ${coverage}` : message;
    } catch (err) {
      log.error({ err }, "leave_preview_coverage_failed");
      return message;
    }
  };
  try {
    if (forUserId) {
      const { cost, personName } = await previewLeaveFor(ctx, actor, forUserId, parsed.data);
      return reply({ ok: true, message: await withCoverage(formatRequestCost(cost, personName), forUserId), cost });
    }
    const cost = await previewLeaveRequest(ctx, actor, parsed.data);
    return reply({ ok: true, message: await withCoverage(formatRequestCost(cost), actor.id), cost });
  } catch (err) {
    if (isDomainError(err)) {
      const message = (forUserId ? addForMessages[err.code] : undefined) ?? messageForError(err, "leave_preview");
      return reply({ ok: false, message }, 422);
    }
    log.error({ err }, "leave_preview_failed");
    return reply({ ok: false, message: "The preview isn't available right now." }, 500);
  }
}
