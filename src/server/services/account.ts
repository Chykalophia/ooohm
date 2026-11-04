/**
 * The signed-in person's own account: what they see on their settings page, and what
 * they may change themselves: their display name, their colour mode and their passkeys
 * (added and removed in the browser, through Better Auth's passkey plugin). Email, role,
 * department and manager stay with admins (invite-only access; the email is the
 * sign-in identity).
 */
import type { Actor, Role } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES } from "@/domain/events";
import { normalizePersonName } from "@/domain/people";
import type { ColorMode } from "@/domain/color-mode";
import type { ServiceContext } from "@/server/context";
import { findCompanySettings } from "@/server/repositories/calendar";
import { findDepartment } from "@/server/repositories/departments";
import { hasPasskeyOf, listPasskeysOf } from "@/server/repositories/passkeys";
import { findPerson, lockMember, updateColorMode, updatePerson } from "@/server/repositories/users";
import { recordAdminChange } from "./admin-access";
import { personPayload, personSnapshot } from "./admin-people";
import { inTransaction } from "./notify";

export interface Account {
  name: string;
  email: string;
  role: Role;
  /** The department's name, or `null` when they are in none. */
  department: string | null;
  /** The manager's display label (name, else email), or `null` when they have none. */
  manager: string | null;
  /** Their passkeys, oldest first: a name and when it was added, never the key. */
  passkeys: { id: string; name: string | null; createdAt: Date | null; synced: boolean }[];
  /** The company's time zone, to show when each passkey was added. */
  timezone: string;
}

/**
 * The actor's own account details. Five reads at most: the person, then their
 * department, manager, passkeys and the company's time zone in parallel.
 *
 * @throws DomainError `not_found` when the person no longer exists.
 */
export async function getAccount(ctx: ServiceContext, actor: Actor): Promise<Account> {
  const me = await findPerson(ctx.db, actor.companyId, actor.id);
  if (!me) throw new DomainError("not_found");
  const [department, manager, passkeys, settings] = await Promise.all([
    me.departmentId ? findDepartment(ctx.db, actor.companyId, me.departmentId) : undefined,
    me.managerId ? findPerson(ctx.db, actor.companyId, me.managerId) : undefined,
    listPasskeysOf(ctx.db, me.id),
    findCompanySettings(ctx.db, actor.companyId),
  ]);
  return {
    name: me.name,
    email: me.email,
    role: me.role,
    department: department?.name ?? null,
    manager: manager ? manager.name || manager.email : null,
    passkeys: passkeys.map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, synced: p.deviceType === "multiDevice" })),
    timezone: settings?.timezone ?? "UTC",
  };
}

/** Whether the actor has added a passkey yet; Home suggests one until they have. One read. */
export async function hasPasskey(ctx: ServiceContext, actor: Actor): Promise<boolean> {
  return hasPasskeyOf(ctx.db, actor.id);
}

/**
 * Changes the actor's own display name, recorded as `user.updated` with the person as
 * the actor (the same audit row and event an admin's edit writes).
 *
 * @returns The name as saved (unchanged, with nothing recorded, when it is the same).
 * @throws DomainError `invalid_input` for a blank or too long name, or `forbidden` for a
 *   deactivated account.
 */
export async function renameSelf(ctx: ServiceContext, actor: Actor, rawName: string): Promise<string> {
  const name = normalizePersonName(rawName);
  return inTransaction(ctx, async (tx) => {
    const member = await lockMember(tx, actor.companyId, actor.id);
    if (!member?.isActive) throw new DomainError("forbidden");
    const before = await findPerson(tx, actor.companyId, actor.id);
    if (!before) throw new DomainError("forbidden");
    if (before.name === name) return name;
    const after = await updatePerson(tx, actor.companyId, actor.id, { name });
    await recordAdminChange(tx, actor, {
      type: ADMIN_EVENT_TYPES.userUpdated,
      entityType: "user",
      entityId: after.id,
      subjectUserId: after.id,
      before: personSnapshot(before),
      after: personSnapshot(after),
      payload: personPayload(after),
    });
    return after.name;
  });
}

/**
 * Saves the actor's colour mode (light, dark or automatic). A display preference of
 * their own, so no audit row or event (see `@/domain/color-mode`).
 *
 * @throws DomainError `forbidden` for a deactivated or deleted account.
 */
export async function setColorMode(ctx: ServiceContext, actor: Actor, colorMode: ColorMode): Promise<void> {
  if (!(await updateColorMode(ctx.db, actor.companyId, actor.id, colorMode))) throw new DomainError("forbidden");
}
