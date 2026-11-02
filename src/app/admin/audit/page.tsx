import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { formatInstantDateTime } from "@/lib/format";
import { getAuditLog } from "@/server/services/audit-log";
import { AdminShell, requireAdminPage } from "@/app/admin/admin-shell";
import { field, focusRing, outlineButton } from "@/app/styles";

export const metadata: Metadata = { title: "Audit log · Admin · OOOhm" };

const param = z.string().max(200).optional().catch(undefined);

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { actor, ctx, userName, approvals } = await requireAdminPage();
  const params = await searchParams;
  const cursor = param.parse(params.after);
  const log = await getAuditLog(ctx, actor, {
    action: param.parse(params.action),
    actorId: param.parse(params.actor),
    subjectUserId: param.parse(params.person),
    from: param.parse(params.from),
    to: param.parse(params.to),
    cursor,
  });
  const { filters } = log;
  const filterQuery = new URLSearchParams(
    Object.entries({ action: filters.action, actor: filters.actorId, person: filters.subjectUserId, from: filters.from, to: filters.to }).filter(
      (e): e is [string, string] => Boolean(e[1]),
    ),
  );
  const filtered = filterQuery.size > 0;
  const olderHref = log.nextCursor ? `/admin/audit?${new URLSearchParams([...filterQuery, ["after", log.nextCursor]])}` : null;
  const peopleOptions = log.people.map((p) => (
    <option key={p.id} value={p.id}>
      {p.label}
    </option>
  ));

  return (
    <AdminShell
      userName={userName}
      approvals={approvals}
      section="audit"
      title="Audit log"
      description={`Every change, newest first. Times are in ${log.timezone.replaceAll("_", " ")}.`}
    >
      <form method="get" role="search" aria-label="Filter the audit log" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">What</span>
          <select name="action" defaultValue={filters.action ?? ""} className={field}>
            <option value="">Any change</option>
            {log.actions.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Done by</span>
          <select name="actor" defaultValue={filters.actorId ?? ""} className={field}>
            <option value="">Anyone</option>
            {peopleOptions}
          </select>
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">About</span>
          <select name="person" defaultValue={filters.subjectUserId ?? ""} className={field}>
            <option value="">Anyone</option>
            {peopleOptions}
          </select>
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">From</span>
          <input type="date" name="from" defaultValue={filters.from ?? ""} className={field} />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">To</span>
          <input type="date" name="to" defaultValue={filters.to ?? ""} className={field} />
        </label>
        <div className="flex items-end gap-4">
          <button type="submit" className={outlineButton}>
            Filter
          </button>
          {filtered && (
            <Link href="/admin/audit" className={`rounded-md text-sm text-muted hover:text-foreground ${focusRing}`}>
              Clear
            </Link>
          )}
        </div>
      </form>

      {log.entries.length === 0 ? (
        <p className="text-muted">{filtered || cursor ? "Nothing matches." : "Nothing has changed yet."}</p>
      ) : (
        <ol className="divide-y divide-border rounded-2xl border border-border bg-surface">
          {log.entries.map((e) => (
            <li key={e.id} className="space-y-1.5 p-4">
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
            </li>
          ))}
        </ol>
      )}

      {(olderHref || cursor) && (
        <nav aria-label="Pages" className="flex flex-wrap gap-4">
          {cursor && (
            <Link href={filtered ? `/admin/audit?${filterQuery}` : "/admin/audit"} className={outlineButton}>
              Newest
            </Link>
          )}
          {olderHref && (
            <Link href={olderHref} className={outlineButton}>
              Older
            </Link>
          )}
        </nav>
      )}
    </AdminShell>
  );
}
