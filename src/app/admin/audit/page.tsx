import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { formatInstantFull, formatInstantShort } from "@/lib/format";
import { AUDIT_PAGE_SIZE, AUDIT_PAGE_SIZES, type AuditLogEntry, getAuditLog } from "@/server/services/audit-log";
import { AdminShell } from "@/app/admin/admin-shell";
import { readParam } from "@/app/_lib/calendar-input";
import { requireAdminPage } from "@/app/_lib/page-context";
import { listHref, pagerLinks, readPageParams } from "@/app/_lib/paging";
import { PageSizeNav } from "@/components/navigation/page-size-nav";
import { Pager } from "@/components/navigation/pager";
import { type Column, DataTable } from "@/components/ui/data-table";
import { SelectField, TextField } from "@/components/ui/fields";
import { FilterBar } from "@/components/ui/filter-bar";
import { cx, focusRing } from "@/components/ui/styles";

export const metadata: Metadata = { title: "Audit log · Admin · OOOhm" };

const PATH = "/admin/audit";
const param = z.string().max(200).optional().catch(undefined);
const sizeParam = z.string().regex(/^\d{1,3}$/);

/** A cell value that narrows the log to itself when clicked: the action, or a person. */
const filterLink = cx("rounded-sm underline-offset-4 hover:underline", focusRing);

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { actor, ctx, nav } = await requireAdminPage();
  const params = await searchParams;
  const { cursor, number } = readPageParams(params);
  const log = await getAuditLog(ctx, actor, {
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
  const keep = { action: filters.action, actor: filters.actorId, person: filters.subjectUserId, from: filters.from, to: filters.to };
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
      className: "w-px whitespace-nowrap text-muted tabular-nums",
      cell: (e) => (
        <time dateTime={e.at.toISOString()} title={formatInstantFull(e.at, timezone)}>
          {formatInstantShort(e.at, timezone, now)}
        </time>
      ),
    },
    {
      header: "What",
      className: "font-medium",
      cell: (e) => (
        <Link href={href({ action: e.action })} className={filterLink} title={`Only “${e.label}”`}>
          {e.label}
        </Link>
      ),
    },
    {
      header: "About",
      hideOnPhone: true,
      className: "max-w-40",
      cell: (e) => (
        <span className="block truncate">
          {e.subjectName ? person(e.subjectUserId, e.subjectName, "person") : <span className="text-muted">None</span>}
        </span>
      ),
    },
    {
      header: "By",
      hideOnPhone: true,
      className: "max-w-44",
      cell: (e) => (
        <span className={cx("block truncate", e.actorKind === "system" && "text-muted")}>
          {e.actorKind === "system" ? e.actorLabel : person(e.actorId, e.actorLabel, "actor")}
        </span>
      ),
    },
  ];

  return (
    <AdminShell nav={nav} section="audit" title="Audit log" description={`Every change. Times are in ${timezone.replaceAll("_", " ")}.`}>
      <FilterBar label="Filter the audit log" path={PATH} filtered={filtered} autoApply className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <SelectField
          label="What"
          className="col-span-2 sm:col-span-1"
          name="action"
          defaultValue={filters.action ?? ""}
          options={[{ value: "", label: "Any change" }, ...log.actions]}
        />
        <SelectField
          label="Done by"
          name="actor"
          defaultValue={filters.actorId ?? ""}
          options={[{ value: "", label: "Anyone" }, ...log.people.map((p) => ({ value: p.id, label: p.label }))]}
        />
        <SelectField
          label="About"
          name="person"
          defaultValue={filters.subjectUserId ?? ""}
          options={[{ value: "", label: "Anyone" }, ...log.people.map((p) => ({ value: p.id, label: p.label }))]}
        />
        <TextField label="From" type="date" name="from" defaultValue={filters.from ?? ""} />
        <TextField label="To" type="date" name="to" defaultValue={filters.to ?? ""} />
        {/* The view rides along, so a new filter keeps the order and rows a page. */}
        {view.order && <input type="hidden" name="order" value={view.order} />}
        {view.size && <input type="hidden" name="size" value={view.size} />}
      </FilterBar>

      <div className="space-y-3">
        <div className="flex justify-end">
          <PageSizeNav
            sizes={AUDIT_PAGE_SIZES}
            current={log.size}
            href={(size) => href({ size: size === AUDIT_PAGE_SIZE ? undefined : String(size) })}
          />
        </div>
        {log.entries.length === 0 ? (
          <p className="text-muted">{filtered || log.previous ? "Nothing matches." : "Nothing has changed yet."}</p>
        ) : (
          <DataTable
            caption={`Audit log, ${log.oldestFirst ? "oldest" : "newest"} first`}
            columns={columns}
            rows={log.entries}
            rowKey={(e) => e.id}
            rowLabel={(e) => `${e.label}, ${formatInstantShort(e.at, timezone, now)}`}
            detail={(e) => <AuditDetail entry={e} timezone={timezone} />}
          />
        )}
      </div>

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
