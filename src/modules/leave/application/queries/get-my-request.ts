import "server-only";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { todayInTimeZone } from "@/lib/dates";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { canCancelOn } from "../../domain/leave-status";
import type { MyRequestDTO } from "../dto";
import type { LeaveDeps } from "../ports";

/**
 * One of the actor's own requests in full, for its own page: the leave, who decides it
 * and what they said, when it was sent and decided (with the company's time zone to
 * show those in), and whether it can be cancelled today.
 *
 * Fails with `not_found` (not a request of theirs, someone else's included) or `no_company`.
 */
export async function getMyRequest(deps: LeaveDeps, actor: Actor, id: string): Promise<ServiceResult<MyRequestDTO>> {
  if (!isUuid(id)) return err("not_found");
  return attempt(async () => {
    const [settings, request] = await Promise.all([
      deps.read.directory.companySettings(actor.companyId),
      deps.read.requests.findOwn(actor.companyId, actor.id, id),
    ]);
    if (!settings) throw new DomainError("no_company");
    if (!request) throw new DomainError("not_found");
    const today = todayInTimeZone(settings.timezone, deps.clock.now());
    return { request: { ...request, cancellable: canCancelOn(request, today) }, timezone: settings.timezone };
  });
}
