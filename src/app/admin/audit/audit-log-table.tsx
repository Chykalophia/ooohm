import Link from "next/link";
import { formatInstantFull, formatInstantShort } from "@/lib/format";
import { AUDIT_PAGE_SIZE, AUDIT_PAGE_SIZES, type AuditLogDTO, type AuditLogEntryDTO as AuditLogEntry, type AuditLogPresentation } from "@/modules/audit";
import { PageSizeNav } from "@/components/navigation/page-size-nav";
import { type Column, DataTable } from "@/components/ui/data-table";
import { SelectField, TextField } from "@/components/ui/fields";
import { TableToolbar } from "@/components/ui/table-toolbar";
import { cx, focusRing } from "@/components/ui/styles";

const ANYONE = { value: "", label: "Anyone" };

/** A cell value that narrows the log to itself when clicked: the action, or a person. */
const filterLink = cx("rounded-sm underline-offset-4 hover:underline", focusRing);

/** What each row shows for its action and people, in its cells and when opened. */
function cellsOf(view: AuditLogPresentation) {
  const person = (id: string | null, name: string, filter: "actor" | "person") =>
    view.canFilterByPerson(id) ? (
      <Link
        href={view.href({ [filter]: id })}
        className={filterLink}
        title={filter === "actor" ? `Only changes by ${name}` : `Only changes about ${name}`}
      >
        {name}
      </Link>
    ) : (
      name
    );
  const what = (e: AuditLogEntry) =>
    view.canFilterByAction(e.action) ? (
      <Link href={view.href({ action: e.action })} className={filterLink} title={`Only “${e.label}”`}>
        {e.label}
      </Link>
    ) : (
      e.label
    );
  const by = (e: AuditLogEntry) => (e.actorKind === "system" ? e.actorLabel : person(e.actorId, e.actorLabel, "actor"));
  const about = (e: AuditLogEntry) => (e.subjectName ? person(e.subjectUserId, e.subjectName, "person") : null);
  return { what, by, about };
}

function columnsOf(log: AuditLogDTO, view: AuditLogPresentation, now: Date): Column<AuditLogEntry>[] {
  const { what, by, about } = cellsOf(view);
  return [
    {
      header: (
        <Link href={view.sortHref} className={cx("inline-flex items-center gap-1 rounded-sm hover:text-foreground", focusRing)} aria-label={view.sortLabel}>
          When <span aria-hidden>{log.oldestFirst ? "↑" : "↓"}</span>
        </Link>
      ),
      sort: log.oldestFirst ? "ascending" : "descending",
      className: "w-40 text-muted tabular-nums",
      cell: (e) => (
        <time dateTime={e.at.toISOString()} title={formatInstantFull(e.at, log.timezone)} className="block truncate">
          {formatInstantShort(e.at, log.timezone, now)}
        </time>
      ),
    },
    {
      header: "What",
      className: "font-medium",
      cell: (e) => (
        <span className="block truncate" title={e.label}>
          {what(e)}
        </span>
      ),
    },
    {
      header: "About",
      hideOnPhone: true,
      className: "w-32",
      cell: (e) => (
        <span className="block truncate" title={e.subjectName ?? undefined}>
          {about(e) ?? <span className="text-muted">None</span>}
        </span>
      ),
    },
    {
      header: "By",
      hideOnPhone: true,
      className: "w-36",
      cell: (e) => (
        <span className={cx("block truncate", e.actorKind === "system" && "text-muted")} title={e.actorLabel}>
          {by(e)}
        </span>
      ),
    },
  ];
}

/** The search box, the filters and the page size above the log. */
function AuditToolbar({ log, view, path }: { log: AuditLogDTO; view: AuditLogPresentation; path: string }) {
  const { filters } = log;
  return (
    <TableToolbar
      label="Search and filter the audit log"
      path={path}
      search={{ name: "q", value: filters.query ?? "", placeholder: "Search changes and people" }}
      activeFilterCount={view.filterCount}
      active={view.active}
      clearHref={view.clearHref}
      keep={view.view}
      aside={
        <PageSizeNav sizes={AUDIT_PAGE_SIZES} current={log.size} href={(size) => view.href({ size: size === AUDIT_PAGE_SIZE ? undefined : String(size) })} />
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
          <SelectField size="sm" label="Done by" name="actor" defaultValue={filters.actorId ?? ""} options={[ANYONE, ...view.peopleOptions]} />
          <SelectField size="sm" label="About" name="person" defaultValue={filters.subjectUserId ?? ""} options={[ANYONE, ...view.peopleOptions]} />
          <TextField size="sm" label="From" type="date" name="from" defaultValue={filters.from ?? ""} />
          <TextField size="sm" label="To" type="date" name="to" defaultValue={filters.to ?? ""} />
        </>
      }
    />
  );
}

/** The audit log as a table: one row per change, each opening to {@link AuditDetail}. */
export function AuditLogTable({ log, view, path }: { log: AuditLogDTO; view: AuditLogPresentation; path: string }) {
  const now = new Date();
  const { what, by, about } = cellsOf(view);
  return (
    <DataTable
      caption={view.caption}
      fixed
      toolbar={<AuditToolbar log={log} view={view} path={path} />}
      empty={view.empty}
      columns={columnsOf(log, view, now)}
      rows={log.entries}
      rowKey={(e) => e.id}
      rowLabel={(e) => `${e.label}, ${formatInstantShort(e.at, log.timezone, now)}`}
      detail={(e) => <AuditDetail entry={e} timezone={log.timezone} what={what(e)} by={by(e)} about={about(e)} />}
    />
  );
}

/**
 * Everything about one change, shown when its row opens: what in full (a phone cuts it
 * short in the row, and touch has no tooltip), the full time, who, about whom (with the
 * same filter links as the row, which a phone hides), and each field.
 */
function AuditDetail({
  entry: e,
  timezone,
  what,
  by,
  about,
}: {
  entry: AuditLogEntry;
  timezone: string;
  what: React.ReactNode;
  by: React.ReactNode;
  about: React.ReactNode;
}) {
  const facts: [string, React.ReactNode][] = [
    ["What", what],
    ["When", formatInstantFull(e.at, timezone)],
    ["By", by],
    ...(about ? [["About", about] as [string, React.ReactNode]] : []),
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
