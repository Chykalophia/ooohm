import "server-only";
/**
 * Import step: who of the plan's people is imported, and who already has an account.
 */
import type { Role } from "@/domain/actor";
import type { ExistingAccount } from "@/server/repositories/imports";
import type { ImportIssue, PlannedPerson } from "@/modules/import/domain/timeoff/plan/types";
import { refuse } from "./run";

const ROLE_RANK: Readonly<Record<Role, number>> = { employee: 0, manager: 1, admin: 2 };

export interface MatchedPeople {
  /** Accounts that already exist for the plan's emails, in any company. */
  existingByEmail: Map<string, ExistingAccount>;
  /** TimeOff ids left out because their email belongs to another company. */
  excluded: Set<number>;
  /** The people imported. */
  people: PlannedPerson[];
  /** TimeOff id → OOOhm user id (the existing account's, or a new one). */
  idOf: Map<number, string>;
  /** Conflicts found here, for the report. */
  conflicts: ImportIssue[];
}

/**
 * Matches the plan's people to existing accounts by email. Someone whose email belongs
 * to another company is left out (with their leave). New people get ids from `newId`, in
 * plan order.
 */
export function matchPeople(planned: readonly PlannedPerson[], existing: readonly ExistingAccount[], companyId: string, newId: () => string): MatchedPeople {
  const existingByEmail = new Map(existing.map((a) => [a.email, a]));
  const excluded = new Set<number>();
  const conflicts: ImportIssue[] = [];
  for (const p of planned) {
    const account = existingByEmail.get(p.email);
    if (account && account.companyId !== companyId) {
      excluded.add(p.key);
      conflicts.push({ code: "email_in_other_company", email: p.email, timeoffId: p.key, message: `${p.email} already has an account in another company; not imported, nor their leave.` });
    }
  }
  const people = planned.filter((p) => !excluded.has(p.key));
  const idOf = new Map<number, string>(people.map((p) => [p.key, existingByEmail.get(p.email)?.id ?? newId()]));
  return { existingByEmail, excluded, people, idOf, conflicts };
}

/** A person's role after the import: TimeOff's, unless their existing account's is higher. */
export function roleAfterImport(m: Pick<MatchedPeople, "existingByEmail">, p: PlannedPerson): Role {
  const existing = m.existingByEmail.get(p.email);
  return existing && ROLE_RANK[existing.role] > ROLE_RANK[p.role] ? existing.role : p.role;
}

/** Whether a person is active after the import: an existing account keeps its state. */
export function activeAfterImport(m: Pick<MatchedPeople, "existingByEmail">, p: PlannedPerson): boolean {
  return m.existingByEmail.get(p.email)?.isActive ?? p.isActive;
}

/** Active admins after the import: imported ones, plus the company's own that the import does not touch. */
export function activeAdminsAfter(m: MatchedPeople, accounts: readonly ExistingAccount[]): number {
  const importedEmails = new Set(m.people.map((p) => p.email));
  return (
    m.people.filter((p) => roleAfterImport(m, p) === "admin" && activeAfterImport(m, p)).length +
    accounts.filter((a) => a.role === "admin" && a.isActive && !importedEmails.has(a.email)).length
  );
}

/** @throws DomainError `import_refused` when the import would leave the company without an active admin. */
export function assertKeepsAnActiveAdmin(m: MatchedPeople, accounts: readonly ExistingAccount[]): void {
  if (activeAdminsAfter(m, accounts) === 0) {
    refuse("After the import the company would have no active admin, so nobody could manage it. Make someone an admin in TimeOff, or seed an admin first (SEED_ADMIN_EMAIL).");
  }
}
