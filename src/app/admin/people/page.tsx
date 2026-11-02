import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { personLabel } from "@/domain/person";
import { listPeople } from "@/server/services/admin-people";
import { AdminShell, requireAdminPage } from "@/app/admin/admin-shell";
import { field, focusRing, outlineButton, primaryButton } from "@/app/admin/styles";
import { departmentParamSchema, readParam } from "@/app/calendar-input";

export const metadata: Metadata = { title: "People · Admin · OOOhm" };

const ROLE_LABEL = { employee: "Employee", manager: "Manager", admin: "Admin" } as const;

const statusSchema = z.enum(["active", "inactive", "all"]).catch("active");
const querySchema = z.string().max(100).catch("");

export default async function PeoplePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { actor, ctx, userName, approvals } = await requireAdminPage();
  const params = await searchParams;
  const status = statusSchema.parse(params.status);
  const query = querySchema.parse(params.q);
  const departmentId = readParam(departmentParamSchema, params.department) ?? "";
  const { people, truncated, departments } = await listPeople(ctx, actor, { status, query, departmentId: departmentId || undefined });
  const filtered = query !== "" || status !== "active" || departmentId !== "";

  return (
    <AdminShell
      userName={userName}
      approvals={approvals}
      section="people"
      title="People"
      description="Everyone who can sign in. Invite someone and they get an email with a sign-in link."
      action={
        <Link href="/admin/people/new" className={primaryButton}>
          Invite someone
        </Link>
      }
    >
      <form method="get" role="search" aria-label="Filter people" className="flex flex-wrap items-end gap-3">
        <label className="block min-w-48 flex-1 space-y-1.5">
          <span className="text-sm font-medium">Name or email</span>
          <input type="search" name="q" defaultValue={query} maxLength={100} className={field} />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Status</span>
          <select name="status" defaultValue={status} className={field}>
            <option value="active">Active</option>
            <option value="inactive">Deactivated</option>
            <option value="all">Everyone</option>
          </select>
        </label>
        {departments.length > 0 && (
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Department</span>
            <select name="department" defaultValue={departmentId} className={field}>
              <option value="">All</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit" className={outlineButton}>
          Filter
        </button>
        {filtered && (
          <Link href="/admin/people" className={`self-center text-sm text-muted hover:text-foreground ${focusRing} rounded-md`}>
            Clear
          </Link>
        )}
      </form>

      {people.length === 0 ? (
        <p className="text-muted">{filtered ? "Nobody matches that filter." : "Nobody here yet."}</p>
      ) : (
        <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
          {people.map((p) => (
            <li key={p.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <p className="font-medium break-words">
                  <Link href={`/admin/people/${p.id}`} className={`underline-offset-4 hover:underline ${focusRing} rounded-md`}>
                    {p.name || p.email}
                  </Link>
                  {!p.isActive && <span className="ml-2 text-sm font-normal text-muted">Deactivated</span>}
                </p>
                <p className="text-sm break-all text-muted">{p.email}</p>
                <p className="text-sm text-muted">
                  {[
                    p.departmentName,
                    p.managerId ? `Reports to ${personLabel({ name: p.managerName ?? "", email: p.managerEmail ?? "" }) || "someone"}` : "No manager",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <div className="shrink-0 text-sm sm:text-right">
                <p>{ROLE_LABEL[p.role]}</p>
                {p.canSelfApprove && <p className="text-muted">Approves own requests</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {truncated && <p className="text-sm text-muted">Showing the first {people.length}. Narrow the filter to find someone.</p>}
    </AdminShell>
  );
}
