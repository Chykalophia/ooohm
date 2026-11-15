import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { DomainError } from "@/shared/kernel/errors";
import type { ServiceContext } from "@/server/context";
import { findCompany, findDepartment } from "@/modules/organisation";
import { type AccountDTO, toPasskeyDTO } from "@/modules/people/application/dto";
import { listPasskeysOf } from "@/modules/people/infrastructure/drizzle-passkeys.repository";
import { findPerson } from "@/shared/lib/db/members";
import { attempt, type ServiceResult } from "@/shared/lib/result";

/**
 * The actor's own account, for their settings page: what they may change themselves
 * (their display name, colour mode and passkeys) and what stays with admins (email,
 * role, department, manager). Five reads at most: the person, then their department,
 * manager, passkeys and the company's time zone in parallel.
 *
 * Fails with `not_found` when the person no longer exists.
 */
export async function getAccount(ctx: ServiceContext, actor: Actor): Promise<ServiceResult<AccountDTO>> {
  return attempt(async () => {
    const me = await findPerson(ctx.db, actor.companyId, actor.id);
    if (!me) throw new DomainError("not_found");
    const [department, manager, passkeys, company] = await Promise.all([
      me.departmentId ? findDepartment(ctx.db, actor.companyId, me.departmentId) : undefined,
      me.managerId ? findPerson(ctx.db, actor.companyId, me.managerId) : undefined,
      listPasskeysOf(ctx.db, me.id),
      findCompany(ctx.db, actor.companyId),
    ]);
    return {
      name: me.name,
      email: me.email,
      role: me.role,
      department: department?.name ?? null,
      manager: manager ? manager.name || manager.email : null,
      passkeys: passkeys.map(toPasskeyDTO),
      timezone: company?.timezone ?? "UTC",
    };
  });
}
