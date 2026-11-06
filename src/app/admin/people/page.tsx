import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { personLabel } from "@/domain/person";
import { DELETION_GRACE_DAYS } from "@/domain/person-deletion";
import { formatInstantDate, ROLE_LABEL } from "@/lib/format";
import { listPeople } from "@/server/services/admin-people";
import { AdminShell } from "@/app/admin/admin-shell";
import { requireAdminPage } from "@/app/_lib/page-context";
import { Item, ItemList } from "@/components/ui/card";
import { InlineAction } from "@/components/forms/inline-action";
import { cancelDeletionAction } from "@/app/admin/people/actions";
import { nativeCheck, primaryButton, quietLink, textLink } from "@/components/ui/styles";
import { SelectField, TextField } from "@/components/ui/fields";
import { FilterBar } from "@/components/ui/filter-bar";
import { departmentParamSchema, readParam } from "@/app/_lib/calendar-input";
import { pagerLinks, readPageParams } from "@/app/_lib/paging";
import { Pager } from "@/components/navigation/pager";

export const metadata: Metadata = { title: "People · Admin · OOOhm" };

// NUL is refused by Postgres in text, so it is dropped rather than turned into an error page.
const querySchema = z
  .string()
  .transform((s) => s.replaceAll("\u0000", "").slice(0, 100))
  .catch("");
const noticeSchema = z.enum(["scrubbed", "records_kept", "scheduled", "already_scheduled"]).optional().catch(undefined);

/** What the page says after a delete sent the admin here. */
const NOTICES = {
  scrubbed: "Deleted. Nothing about them is left in OOOhm.",
  records_kept: "Deleted. Their sign-in and email are gone; their records stay under their name, marked (deleted).",
  scheduled: `Scheduled. They'll be deleted in ${DELETION_GRACE_DAYS} days; until then you can undo it here.`,
  already_scheduled: "Already scheduled: nothing changed. The date is below, with Undo.",
} as const;

export default async function PeoplePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { actor, ctx, nav } = await requireAdminPage();
  const params = await searchParams;
  // Deactivated people are hidden unless asked for; deleted people never show here.
  const showInactive = params.inactive === "1";
  const query = querySchema.parse(params.q);
  const notice = noticeSchema.parse(params.notice);
  const departmentId = readParam(departmentParamSchema, params.department) ?? "";
  const { cursor, number } = readPageParams(params);
  const list = await listPeople(
    ctx,
    actor,
    { status: showInactive ? "all" : "active", query, departmentId: departmentId || undefined },
    cursor,
  );
  const { people, departments, timezone } = list;
  const pager = pagerLinks("/admin/people", list, number, { keep: { q: query, department: departmentId, inactive: showInactive ? "1" : undefined } });
  const filtered = query !== "" || showInactive || departmentId !== "";

  return (
    <AdminShell
      nav={nav}
      section="people"
      title="People"
      description="Everyone who can sign in. Invite someone and they get an email with a sign-in link."
      action={
        <div className="flex flex-wrap items-center gap-4">
          <Link href="/admin/people/import" className={quietLink}>
            Import from CSV
          </Link>
          <Link href="/admin/people/new" className={primaryButton}>
            Invite someone
          </Link>
        </div>
      }
    >
      {notice && (
        <p role="status" className="text-sm text-accent-ink">
          {NOTICES[notice]}
        </p>
      )}
      <FilterBar label="Filter people" path="/admin/people" filtered={filtered} className="flex flex-wrap items-end gap-3">
        <TextField label="Name or email" type="search" name="q" defaultValue={query} maxLength={100} className="min-w-48 flex-1" />
        {departments.length > 0 && (
          <SelectField
            label="Department"
            name="department"
            defaultValue={departmentId}
            options={[{ value: "", label: "All" }, ...departments.map((d) => ({ value: d.id, label: d.name }))]}
          />
        )}
        <label className="flex items-center gap-2 self-end py-2.5 text-sm">
          <input type="checkbox" name="inactive" value="1" defaultChecked={showInactive} className={nativeCheck} />
          Show inactive
        </label>
      </FilterBar>

      {people.length === 0 ? (
        <p className="text-muted">{list.previous ? "Nobody on this page." : filtered ? "Nobody matches that filter." : "Nobody here yet."}</p>
      ) : (
        <ItemList>
          {people.map((p) => (
            <Item key={p.id} className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <p className="font-medium break-words">
                  <Link href={`/admin/people/${p.id}`} className={textLink}>
                    {p.name || p.email}
                  </Link>
                  {!p.isActive && <span className="ml-2 text-sm font-normal text-muted">Deactivated</span>}
                </p>
                <p className="text-sm break-all text-muted">{p.email}</p>
                {p.scrubScheduledAt && (
                  <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span>Scheduled for deletion on {formatInstantDate(p.scrubScheduledAt, timezone)}</span>
                    <span aria-hidden="true" className="text-muted">
                      ·
                    </span>
                    <InlineAction
                      action={cancelDeletionAction}
                      fields={{ userId: p.id }}
                      label="Undo"
                      ariaLabel={`Undo the deletion of ${p.name || p.email}`}
                      pendingLabel="Undoing…"
                    />
                  </div>
                )}
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
            </Item>
          ))}
        </ItemList>
      )}
      <Pager label="People pages" links={pager} />
    </AdminShell>
  );
}
