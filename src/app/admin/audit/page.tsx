import type { Metadata } from "next";
import { z } from "zod";
import { formatInstantDateTime } from "@/lib/format";
import { getAuditLog } from "@/server/services/audit-log";
import { AdminShell } from "@/app/admin/admin-shell";
import { requireAdminPage } from "@/app/_lib/page-context";
import { pagerLinks, readPageParams } from "@/app/_lib/paging";
import { Item, ItemList } from "@/components/ui/card";
import { SelectField, TextField } from "@/components/ui/fields";
import { FilterBar } from "@/components/ui/filter-bar";
import { Pager } from "@/components/navigation/pager";

export const metadata: Metadata = { title: "Audit log · Admin · OOOhm" };

const param = z.string().max(200).optional().catch(undefined);

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
    page: cursor,
  });
  const { filters } = log;
  const keep = { action: filters.action, actor: filters.actorId, person: filters.subjectUserId, from: filters.from, to: filters.to };
  const filtered = Object.values(keep).some(Boolean);
  const pager = pagerLinks("/admin/audit", log, number, { keep });
  const peopleOptions = log.people.map((p) => ({ value: p.id, label: p.label }));

  return (
    <AdminShell
      nav={nav}
      section="audit"
      title="Audit log"
      description={`Every change, newest first. Times are in ${log.timezone.replaceAll("_", " ")}.`}
    >
      <FilterBar label="Filter the audit log" clearHref="/admin/audit" filtered={filtered} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <SelectField label="What" name="action" defaultValue={filters.action ?? ""} options={[{ value: "", label: "Any change" }, ...log.actions]} />
        <SelectField label="Done by" name="actor" defaultValue={filters.actorId ?? ""} options={[{ value: "", label: "Anyone" }, ...peopleOptions]} />
        <SelectField label="About" name="person" defaultValue={filters.subjectUserId ?? ""} options={[{ value: "", label: "Anyone" }, ...peopleOptions]} />
        <TextField label="From" type="date" name="from" defaultValue={filters.from ?? ""} />
        <TextField label="To" type="date" name="to" defaultValue={filters.to ?? ""} />
      </FilterBar>

      {log.entries.length === 0 ? (
        <p className="text-muted">{filtered || log.previous ? "Nothing matches." : "Nothing has changed yet."}</p>
      ) : (
        <ItemList ordered>
          {log.entries.map((e) => (
            <Item key={e.id} className="space-y-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="font-medium">
                  {e.label}
                  {e.subjectName && <span className="font-normal text-muted"> · {e.subjectName}</span>}
                </p>
                <p className="text-sm text-muted">
                  <time dateTime={e.at.toISOString()}>{formatInstantDateTime(e.at, log.timezone)}</time>
                </p>
              </div>
              <p className="text-sm text-muted">{e.actorKind === "system" ? e.actorLabel : `By ${e.actorLabel}`}</p>
              {e.changes.length > 0 && (
                <ul className="space-y-0.5 text-sm break-words">
                  {e.changes.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              )}
            </Item>
          ))}
        </ItemList>
      )}

      <Pager label="Audit log pages" links={pager} />
    </AdminShell>
  );
}
