import type { ActiveFilter } from "@/components/ui/table-toolbar";
import { formatShortDate } from "@/lib/format";
import type { AuditLogDTO } from "../application/dto";
import { AUDIT_PAGE_SIZE } from "../application/schemas";

type Query = Record<string, string | undefined>;

/** What the audit log page renders around its rows: links, filter chips, picker options and wording. */
export interface AuditLogPresentation {
  /** A link to the log with `change` applied to its filters and view; a changed filter, order or size starts at page 1. */
  href: (change: Query) => string;
  /** What the pager's links keep: the filters, then the view. */
  pagerKeep: Query;
  /** The view (order, rows) the toolbar's form keeps, each only when it is not the default. */
  view: Query;
  clearHref: string;
  /** The filters in force, as chips that each remove themselves. */
  active: ActiveFilter[];
  /** How many filters (not the search) are in force. */
  filterCount: number;
  peopleOptions: { value: string; label: string }[];
  /** Whether a person can be filtered on: only people the pickers offer (not deleted). */
  canFilterByPerson: (id: string | null) => id is string;
  /** Whether an action can be filtered on: an action the pickers do not offer (from a newer version) cannot. */
  canFilterByAction: (action: string) => boolean;
  sortHref: string;
  sortLabel: string;
  caption: string;
  empty: string;
}

/**
 * The audit log page's view model.
 *
 * @param link Builds a link to the page from a query (empty values dropped).
 */
export function presentAuditLog(log: AuditLogDTO, link: (query: Query) => string): AuditLogPresentation {
  const { filters } = log;
  const keep = {
    q: filters.query,
    action: filters.action,
    actor: filters.actorId,
    person: filters.subjectUserId,
    from: filters.from,
    to: filters.to,
  };
  const view = { order: log.oldestFirst ? "oldest" : undefined, size: log.size === AUDIT_PAGE_SIZE ? undefined : String(log.size) };
  const href = (change: Query) => link({ ...keep, ...view, ...change });

  const nameOf = (id: string | undefined) => log.people.find((p) => p.id === id)?.label ?? "someone";
  const chip = (param: keyof typeof keep, label: string, value: string | undefined): ActiveFilter[] =>
    value ? [{ label, value, removeHref: href({ [param]: undefined }) }] : [];
  const active = [
    ...chip("q", "Search", filters.query),
    ...chip("action", "What", filters.action && log.actions.find((a) => a.value === filters.action)?.label),
    ...chip("actor", "Done by", filters.actorId && nameOf(filters.actorId)),
    ...chip("person", "About", filters.subjectUserId && nameOf(filters.subjectUserId)),
    ...chip("from", "From", filters.from && formatShortDate(filters.from)),
    ...chip("to", "To", filters.to && formatShortDate(filters.to)),
  ];

  const pickable = new Set(log.people.map((p) => p.id));
  const filterable = new Set(log.actions.map((a) => a.value));
  const filtered = Object.values(keep).some(Boolean);
  const order = log.oldestFirst ? "oldest" : "newest";
  const other = log.oldestFirst ? "newest" : "oldest";

  return {
    href,
    pagerKeep: { ...keep, ...view },
    view,
    clearHref: link(view),
    active,
    filterCount: active.length - (filters.query ? 1 : 0),
    peopleOptions: log.people.map((p) => ({ value: p.id, label: p.label })),
    canFilterByPerson: (id): id is string => id !== null && pickable.has(id),
    canFilterByAction: (action) => filterable.has(action),
    sortHref: href({ order: log.oldestFirst ? undefined : "oldest" }),
    sortLabel: `When: ${order} first. Show ${other} first.`,
    caption: `Audit log, ${order} first`,
    empty: filtered ? "Nothing matches. Try fewer words or filters." : log.previous ? "Nothing on this page." : "Nothing has changed yet.",
  };
}
