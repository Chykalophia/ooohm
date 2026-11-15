import "server-only";
/**
 * Import steps: people (rows only: no session, account link, token or email), and the
 * admin the import is attributed to.
 */
import type { Transaction } from "@/db/types";
import { byUser, CHANGE_PROCESSES, type UserChangeSource } from "@/domain/change-source";
import { IMPORT_AUDIT_ACTIONS } from "@/domain/events";
import type { CompanyRow } from "@/server/repositories/companies";
import { findAccountsByEmail, insertImportedAccounts, type NewImportedAccount, updateImportedAccount } from "@/server/repositories/imports";
import type { PlannedPerson } from "@/modules/import/domain/timeoff/plan/types";
import { activeAfterImport, type MatchedPeople, roleAfterImport } from "./match-people";
import { accountSnapshot, actorEmailOf, entry, type ImportRun, refuse } from "./run";

const departmentOf = (p: PlannedPerson, departmentId: ReadonlyMap<number, string>) =>
  p.departmentKey !== null ? (departmentId.get(p.departmentKey) ?? null) : null;

/** The accounts to create: the people with no account yet. */
export function newAccountRows(m: MatchedPeople, companyId: string, departmentId: ReadonlyMap<number, string>): NewImportedAccount[] {
  return m.people
    .filter((p) => !m.existingByEmail.has(p.email))
    .map((p) => ({
      id: m.idOf.get(p.key)!,
      companyId,
      email: p.email,
      name: p.name,
      role: p.role,
      departmentId: departmentOf(p, departmentId),
      canSelfApprove: p.canSelfApprove,
      isActive: p.isActive,
      createdAt: new Date(p.createdAt),
    }));
}

/** A person as the import leaves them. An existing account keeps a higher role and its self-approval. */
export function personAfterImport(m: MatchedPeople, p: PlannedPerson, departmentId: ReadonlyMap<number, string>) {
  const existing = m.existingByEmail.get(p.email);
  return {
    name: p.name,
    role: roleAfterImport(m, p),
    departmentId: departmentOf(p, departmentId),
    managerId: p.managerKey !== null ? (m.idOf.get(p.managerKey) ?? null) : null,
    canSelfApprove: p.canSelfApprove || (existing?.canSelfApprove ?? false),
  };
}

/** Creates the new accounts, then sets managers and updates existing accounts. @returns How many accounts were created. */
export async function applyPeople(run: ImportRun, m: MatchedPeople, departmentId: ReadonlyMap<number, string>): Promise<number> {
  const rows = newAccountRows(m, run.company.id, departmentId);
  await insertImportedAccounts(run.tx, rows);
  for (const p of m.people) {
    const existing = m.existingByEmail.get(p.email);
    const id = m.idOf.get(p.key)!;
    const after = personAfterImport(m, p, departmentId);
    if (existing || after.managerId !== null) await updateImportedAccount(run.tx, run.company.id, id, existing ? after : { managerId: after.managerId });
    run.audit.push(
      entry(run.company.id, IMPORT_AUDIT_ACTIONS.user, "user", id, id, existing ? accountSnapshot(existing) : null, {
        ...after,
        email: p.email,
        isActive: activeAfterImport(m, p),
        timeoffUserId: p.key,
      }),
    );
  }
  return rows.length;
}

/**
 * The import's source: the admin named by `actorEmail`, through the import. Read after
 * people are imported, so it sees roles and accounts as the import leaves them (with
 * `--create-company` it can be one of TimeOff's admins); nothing has been audited yet,
 * and a refusal rolls everything back.
 *
 * @throws DomainError `import_refused` unless that email is an active admin of `company`.
 */
export async function importActorSource(tx: Transaction, company: CompanyRow, actorEmail: string): Promise<UserChangeSource> {
  const email = actorEmailOf(actorEmail);
  const [account] = await findAccountsByEmail(tx, [email]);
  if (!account || account.companyId !== company.id) {
    refuse(
      `--actor ${email} is not a member of company "${company.name}", nor one of the people this import brings in. ` +
        `Name an active admin of that company: the person running the import.`,
    );
  }
  if (account.role !== "admin" || !account.isActive) {
    refuse(`--actor ${email} is not an active admin of company "${company.name}". Only an active admin may run an import.`);
  }
  return byUser(account.id, CHANGE_PROCESSES.timeoffImport);
}
