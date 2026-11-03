import { randomUUID } from "node:crypto";
import { type Actor, toActor } from "@/domain/actor";
import { byUser, CHANGE_PROCESSES } from "@/domain/change-source";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES } from "@/domain/events";
import { defaultLeaveTypes, type InstallInput, normalizeInstall } from "@/domain/install";
import { setupTokenMatches } from "@/lib/setup-token";
import { log } from "@/lib/log";
import type { ServiceContext } from "@/server/context";
import { insertCompany, lockCompaniesTable } from "@/server/repositories/imports";
import { isInstalled, markInstalled } from "@/server/repositories/installation";
import { insertLeaveType } from "@/server/repositories/leave-types";
import { insertPerson } from "@/server/repositories/users";
import { recordAdminChange } from "./admin-access";
import { recordLeaveTypeChange } from "./admin-leave-types";
import { personPayload, personSnapshot } from "./admin-people";
import { inTransaction } from "./notify";

/**
 * Where this install stands: `installed`, or empty with the web setup `open` (a
 * `SETUP_TOKEN` is configured) or `off` (none is: set one, or run `pnpm db:seed`).
 */
export async function installStatus(ctx: ServiceContext, setupToken: string | undefined): Promise<"installed" | "open" | "off"> {
  if (await isInstalled(ctx.db)) return "installed";
  return setupToken ? "open" : "off";
}

/** Whether the web setup is open ({@link installStatus}). Closed, the setup page is a 404. */
export async function isSetupOpen(ctx: ServiceContext, setupToken: string | undefined): Promise<boolean> {
  return (await installStatus(ctx, setupToken)) === "open";
}

/**
 * The first install from the web: creates the company, its default leave types (PTO
 * first) and the first admin, and closes setup for good with the install marker. The
 * person proves they own the deployment with `SETUP_TOKEN`, and their email by signing
 * in afterwards through the normal sign-in link (setup never signs anyone in).
 *
 * Runs under the same table lock as `pnpm db:seed` and the TimeOff import, and checks
 * nothing is installed inside it, so two setups racing each other cannot both succeed.
 * Audited like any admin change: the new admin, through `first_install`, created
 * themself and each leave type.
 *
 * @param setupToken The configured `SETUP_TOKEN`; without one, setup is refused.
 * @returns The admin's email, to sign in with.
 * @throws DomainError `forbidden` (no token configured, or the wrong one), `not_found`
 *   (already installed), `invalid_input`.
 */
export async function runFirstInstall(
  ctx: ServiceContext,
  input: InstallInput & { token: string },
  setupToken: string | undefined,
): Promise<{ email: string }> {
  if (!setupTokenMatches(input.token, setupToken)) {
    log.warn({}, "setup_token_refused");
    throw new DomainError("forbidden");
  }
  const values = normalizeInstall(input);
  return inTransaction(ctx, async (tx) => {
    await lockCompaniesTable(tx);
    if (await isInstalled(tx)) throw new DomainError("not_found");

    const company = await insertCompany(tx, { name: values.companyName, timezone: values.timezone, workingDays: [1, 2, 3, 4, 5] });
    const admin = await insertPerson(tx, {
      id: randomUUID(),
      companyId: company.id,
      email: values.adminEmail,
      name: values.adminName,
      role: "admin",
      departmentId: null,
      managerId: null,
      // With nobody above them, the first admin approves their own time off.
      canSelfApprove: true,
    });
    const actor: Actor = { ...toActor({ ...admin, companyId: company.id })!, source: byUser(admin.id, CHANGE_PROCESSES.firstInstall) };
    await recordAdminChange(tx, actor, {
      type: ADMIN_EVENT_TYPES.userCreated,
      entityType: "user",
      entityId: admin.id,
      subjectUserId: admin.id,
      before: null,
      after: personSnapshot(admin),
      payload: personPayload(admin),
    });
    for (const type of defaultLeaveTypes()) {
      const row = await insertLeaveType(tx, { companyId: company.id, ...type });
      await recordLeaveTypeChange(tx, actor, ADMIN_EVENT_TYPES.leaveTypeCreated, null, row);
    }
    await markInstalled(tx, "setup");
    log.info({ companyId: company.id, userId: admin.id }, "first_install_done");
    return { email: admin.email };
  });
}
