import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { DomainError } from "@/shared/kernel/errors";
import { isUuid } from "@/shared/kernel/uuid";
import { type PageCursor, readPage, textPart } from "@/shared/kernel/paging";
import type { ServiceContext } from "@/server/context";
import { type DepartmentDTO, findCompany, listDepartments } from "@/modules/organisation";
import { type PersonListItemDTO, toPersonListItemDTO } from "@/modules/people/application/dto";
import { canManagePeople } from "@/modules/people/application/policies";
import { listPeople as listPeopleRows, type PeopleFilter } from "@/modules/people/infrastructure/drizzle-people.repository";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";

/** People per page of the admin list. */
export const PEOPLE_PAGE_SIZE = 50;

/**
 * A people page's key: `[lower(name), email]`. Generous on length: imported names are
 * not held to the form's limit, and a key too long only reads as the first page.
 */
const PEOPLE_KEY = [textPart(500), textPart(320)] as const;

/** Which people the admin list shows (see `PeopleFilter`), without the page. */
export type PeopleListFilter = Omit<PeopleFilter, "page">;

export interface PeoplePageDTO {
  people: PersonListItemDTO[];
  previous: PageCursor | null;
  next: PageCursor | null;
  /** For the filter. */
  departments: DepartmentDTO[];
  /** The company's time zone, for dates. */
  timezone: string;
}

/**
 * One page of the company's people for the admin list, by name, with department and
 * manager names. Deleted people (tombstones) never appear. Three queries in parallel:
 * the page, the departments (for the filter) and the company (its time zone, for dates).
 *
 * @param page From a previous page's `previous` or `next`; the first page when absent.
 * @returns At most {@link PEOPLE_PAGE_SIZE} people, and the cursors either side. Fails
 *   with `forbidden` for a non-admin, or `no_company`.
 */
export async function listPeople(ctx: ServiceContext, actor: Actor, filter: PeopleListFilter, page?: PageCursor): Promise<ServiceResult<PeoplePageDTO>> {
  if (!canManagePeople(actor)) return err("forbidden");
  return attempt(async () => {
    const departmentId = filter.departmentId && isUuid(filter.departmentId) ? filter.departmentId : undefined;
    const [people, departments, company] = await Promise.all([
      readPage({
        cursor: page,
        size: PEOPLE_PAGE_SIZE,
        checks: PEOPLE_KEY,
        read: (request, limit) => listPeopleRows(ctx.db, actor.companyId, { ...filter, departmentId, page: request }, limit),
        keyOf: (p) => [p.sortName, p.email],
      }),
      listDepartments(ctx.db, actor.companyId),
      findCompany(ctx.db, actor.companyId),
    ]);
    if (!company) throw new DomainError("no_company");
    return { people: people.items.map(toPersonListItemDTO), previous: people.previous, next: people.next, departments, timezone: company.timezone };
  });
}
