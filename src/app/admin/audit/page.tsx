import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { formatInstantFull, formatInstantShort, formatShortDate } from "@/lib/format";
import { AUDIT_PAGE_SIZE, AUDIT_PAGE_SIZES, type AuditLogEntry, getAuditLog } from "@/server/services/audit-log";
import { AdminShell } from "@/app/admin/admin-shell";
import { readParam } from "@/app/_lib/calendar-input";
import { requireAdminPage } from "@/app/_lib/page-context";
import { listHref, pagerLinks, readPageParams } from "@/app/_lib/paging";
import { PageSizeNav } from "@/components/navigation/page-size-nav";
import { Pager } from "@/components/navigation/pager";
import { type Column, DataTable } from "@/components/ui/data-table";
import { SelectField, TextField } from "@/components/ui/fields";
import { type ActiveFilter, TableToolbar } from "@/components/ui/table-toolbar";
import { cx, focusRing } from "@/components/ui/styles";

export const metadata: Metadata = { title: "Audit log · Admin · OOOhm" };

const PATH = "/admin/audit";
const ANYONE = { value: "", label: "Anyone" };
const param = z.string().max(200).optional().catch(undefined);
const sizeParam = z.string().regex(/^\d{1,3}$/);

/** A cell value that narrows the log to itself when clicked: the action, or a person. */
const filterLink = cx("rounded-sm underline-offset-4 hover:underline", focusRing);

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { actor, ctx, nav } = await requireAdminPage();
  const params = await searchParams;
  const { cursor, number } = readPageParams(params);
  const log = await getAuditLog(ctx, actor, {
    query: param.parse(params.q),
    action: param.parse(params.action),
    actorId: param.parse(params.actor),
    subjectUserId: param.parse(params.person),
    from: param.parse(params.from),
    to: param.parse(params.to),
    oldestFirst: params.order === "oldest",
    size: Number(readParam(sizeParam, params.size) ?? AUDIT_PAGE_SIZE),
    page: cursor,
  });
  const { filters, timezone } = log;

  // What every link on the page carries: the filters, then the view (order, rows), each
  // only when it is not the default. A changed filter, order or size starts at page 1.
  const keep = {
    q: filters.query,
    action: filters.action,
    actor: filters.actorId,
    person: filters.subjectUserId,
    from: filters.from,
    to: filters.to,
  };
  const view = { order: log.oldestFirst ? "oldest" : undefined, size: log.size === AUDIT_PAGE_SIZE ? undefined : String(log.size) };
  const href = (change: Record<string, string | undefined>) => listHref(PATH, { ...keep, ...view, ...change });
  const filtered = Object.values(keep).some(Boolean);
  const pager = pagerLinks(PATH, log, number, { keep: { ...keep, ...view } });

  // People the pickers offer (not deleted): only they can be filtered on.
  const pickable = new Set(log.people.map((p) => p.id));
  const person = (id: string | null, name: string, filter: "actor" | "person") =>
    id && pickable.has(id) ? (
      <Link
        href={href({ [filter]: id })}
        className={filterLink}
        title={filter === "actor" ? `Only changes by ${name}` : `Only changes about ${name}`}
      >
        {name}
      </Link>
    ) : (
      name
    );
  const now = new Date();

  // The filters in force, as chips that each remove themselves.
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
  const peopleOptions = log.people.map((p) => ({ value: p.id, label: p.label }));

  const columns: Column<AuditLogEntry>[] = [
    {
      header: (
        <Link
          href={href({ order: log.oldestFirst ? undefined : "oldest" })}
          className={cx("inline-flex items-center gap-1 rounded-sm hover:text-foreground", focusRing)}
          aria-label={`When: ${log.oldestFirst ? "oldest" : "newest"} first. Show ${log.oldestFirst ? "newest" : "oldest"} first.`}
        >
          When <span aria-hidden>{log.oldestFirst ? "↑" : "↓"}</span>
        </Link>
      ),
      sort: log.oldestFirst ? "ascending" : "descending",
      className: "w-40 text-muted tabular-nums",
      cell: (e) => (
        <time dateTime={e.at.toISOString()} title={formatInstantFull(e.at, timezone)} className="block truncate">
          {formatInstantShort(e.at, timezone, now)}
        </time>
      ),
    },
    {
      header: "What",
      className: "font-medium",
      cell: (e) => (
        <span className="block truncate">
          <Link href={href({ action: e.action })} className={filterLink} title={`Only “${e.label}”`}>
            {e.label}
          </Link>
        </span>
      ),
    },
    {
      header: "About",
      hideOnPhone: true,
      className: "w-32",
      cell: (e) => (
        <span className="block truncate" title={e.subjectName ?? undefined}>
          {e.subjectName ? person(e.subjectUserId, e.subjectName, "person") : <span className="text-muted">None</span>}
        </span>
      ),
    },
    {
      header: "By",
      hideOnPhone: true,
      className: "w-36",
      cell: (e) => (
        <span className={cx("block truncate", e.actorKind === "system" && "text-muted")} title={e.actorLabel}>
          {e.actorKind === "system" ? e.actorLabel : person(e.actorId, e.actorLabel, "actor")}
        </span>
      ),
    },
  ];

  return (
    <AdminShell nav={nav} section="audit" title="Audit log" description={`Every change. Times are in ${timezone.replaceAll("_", " ")}.`}>
      <DataTable
        caption={`Audit log, ${log.oldestFirst ? "oldest" : "newest"} first`}
        fixed
        toolbar={
          <TableToolbar
            label="Search and filter the audit log"
            path={PATH}
            search={{ name: "q", value: filters.query ?? "", placeholder: "Search changes and people" }}
            activeFilterCount={active.length - (filters.query ? 1 : 0)}
            active={active}
            clearHref={listHref(PATH, view)}
            keep={view}
            aside={
              <PageSizeNav
                sizes={AUDIT_PAGE_SIZES}
                current={log.size}
                href={(size) => href({ size: size === AUDIT_PAGE_SIZE ? undefined : String(size) })}
              />
            }
            filters={
              <>
                <SelectField
                  size="sm"
                  label="What"
                  className="col-span-2 sm:col-span-1"
                  name="action"
                  defaultValue={filters.action ?? ""}
                  options={[{ value: "", label: "Any change" }, ...log.actions]}
                />
                <SelectField
                  size="sm"
                  label="Done by"
                  name="actor"
                  defaultValue={filters.actorId ?? ""}
                  options={[ANYONE, ...peopleOptions]}
                />
                <SelectField
                  size="sm"
                  label="About"
                  name="person"
                  defaultValue={filters.subjectUserId ?? ""}
                  options={[ANYONE, ...peopleOptions]}
                />
                <TextField size="sm" label="From" type="date" name="from" defaultValue={filters.from ?? ""} />
                <TextField size="sm" label="To" type="date" name="to" defaultValue={filters.to ?? ""} />
              </>
            }
          />
        }
        empty={
          filtered ? "Nothing matches. Try fewer words or filters." : log.previous ? "Nothing on this page." : "Nothing has changed yet."
        }
        columns={columns}
        rows={log.entries}
        rowKey={(e) => e.id}
        rowLabel={(e) => `${e.label}, ${formatInstantShort(e.at, timezone, now)}`}
        detail={(e) => <AuditDetail entry={e} timezone={timezone} />}
      />

      <Pager label="Audit log pages" links={pager} />
    </AdminShell>
  );
}

/** Everything about one change, shown when its row opens: the full time, who, about whom, and each field. */
function AuditDetail({ entry: e, timezone }: { entry: AuditLogEntry; timezone: string }) {
  const facts: [string, React.ReactNode][] = [
    ["When", formatInstantFull(e.at, timezone)],
    ["By", e.actorLabel],
    ...(e.subjectName ? [["About", e.subjectName] as [string, React.ReactNode]] : []),
    [
      "Changes",
      e.changes.length > 0 ? (
        <ul className="space-y-0.5 break-words">
          {e.changes.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      ) : (
        <span className="text-muted">No field changes recorded.</span>
      ),
    ],
  ];
  return (
    <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[6rem_1fr]">
      {facts.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="min-w-0">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
