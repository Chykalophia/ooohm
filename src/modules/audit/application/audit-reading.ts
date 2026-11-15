import "server-only";
/**
 * What the audit queries share: naming the ids in a row, matching a search, and reading
 * the viewer's filters.
 */
import { AUDIT_ACTION_LABELS } from "@/modules/audit/domain/audit";
import { DomainError } from "@/shared/kernel/errors";
import { isUuid } from "@/shared/kernel/uuid";
import { isCursorInstant } from "@/shared/kernel/paging";
import { personLabel } from "@/shared/kernel/person-label";
import { formatInstantDateTime } from "@/lib/format";
import type { ServiceContext } from "@/server/context";
import { forTenant } from "@/shared/lib/tenant";
import { findCompany, listAllLeaveTypes, listDepartments } from "@/modules/organisation";
import { listLevels } from "@/modules/organisation";
import { listPeopleNames } from "@/shared/lib/db/members";
import type { AuditRowNames } from "./dto";
import { AUDIT_PAGE_SIZE, AUDIT_PAGE_SIZES, AUDIT_SEARCH_MAX_LENGTH, type AuditPageSize } from "./schemas";

export function pageSize(value: number | undefined): AuditPageSize {
  return AUDIT_PAGE_SIZES.find((s) => s === value) ?? AUDIT_PAGE_SIZE;
}

/** An audit page's key: `[created_at, id]`. */
export const AUDIT_KEY = [isCursorInstant, isUuid] as const;

/** A person id from a link, or nothing: never longer than an id, never with NUL (Postgres refuses it in text). */
export const personId = (v: string | undefined) => (v && v.length <= 100 && !v.includes("\u0000") ? v : undefined);

/**
 * What naming audit rows takes, loaded once per read in parallel: the company (its time
 * zone), its people (deleted ones included, so history still names them), departments,
 * levels and leave types (for ids inside before/after snapshots).
 *
 * @throws DomainError `no_company`.
 */
export async function loadAuditNaming(ctx: ServiceContext, companyId: string) {
  const { db } = forTenant(ctx, companyId);
  const [company, people, departments, levels, leaveTypes] = await Promise.all([
    findCompany(db, companyId),
    listPeopleNames(db, companyId, { includeDeleted: true }),
    listDepartments(db, companyId),
    listLevels(db, companyId),
    listAllLeaveTypes(db, companyId),
  ]);
  if (!company) throw new DomainError("no_company");
  const peopleById = new Map(people.map((p) => [p.id, personLabel(p)]));
  const departmentsById = new Map(departments.map((d) => [d.id, d.name]));
  const levelsById = new Map(levels.map((l) => [l.id, l.name]));
  const typesById = new Map(leaveTypes.map((t) => [t.id, t.name]));
  const names: AuditRowNames = {
    snapshot: {
      person: (id: string) => peopleById.get(id),
      department: (id: string) => departmentsById.get(id),
      level: (id: string) => levelsById.get(id),
      leaveType: (id: string) => typesById.get(id),
      instant: (iso: string) => formatInstantDateTime(new Date(iso), company.timezone),
    },
    adapter: (id) => ctx.adapters.get(id)?.displayName,
  };
  return { company, people, names };
}

/** The most words a search looks for; more are ignored. */
const AUDIT_SEARCH_MAX_WORDS = 5;

/**
 * What a search matches, word by word: for each word, the actions whose label contains
 * it and the people (deleted ones included, as their rows still name them) whose name or
 * email does. A row matches when every word matches its action, who made it or who it
 * is about, so "declined ana" finds Ana's declined requests. Case-insensitive. Only what
 * the viewer shows is matched: an action's label, never its key ("request" is in every
 * `leave_request.*` key but not in "Leave approved"). Like the "Done by" filter, the
 * admin who asked for a system run is not matched as its maker.
 * `undefined` for an empty search.
 */
export function searchFor(raw: string | undefined, people: readonly { id: string; name: string; email: string }[]) {
  const text = raw?.trim().replace(/\s+/g, " ").slice(0, AUDIT_SEARCH_MAX_LENGTH);
  if (!text) return undefined;
  const words = [...new Set(text.toLowerCase().split(" "))].slice(0, AUDIT_SEARCH_MAX_WORDS);
  return {
    text,
    matches: words.map((word) => {
      const has = (value: string) => value.toLowerCase().includes(word);
      return {
        actions: Object.entries(AUDIT_ACTION_LABELS)
          .filter(([, label]) => has(label))
          .map(([action]) => action),
        people: people.filter((p) => has(personLabel(p)) || has(p.email)).map((p) => p.id),
      };
    }),
  };
}
