import type { Metadata } from "next";
import Link from "next/link";
import { normalizeHexColor, readableTextColor } from "@/lib/color";
import { formatDays } from "@/lib/format";
import { type LeaveTypeRow, listLeaveTypesForAdmin } from "@/server/services/admin-leave-types";
import { AdminShell } from "@/app/admin/admin-shell";
import { requireAdminPage } from "@/app/_lib/page-context";
import { Item, ItemList } from "@/components/ui/card";
import { SortableList } from "@/components/ui/sortable-list";
import { InlineAction } from "@/components/forms/inline-action";
import { cx, primaryButton, subtleButton, textLink } from "@/components/ui/styles";
import { archiveLeaveTypeAction, reorderLeaveTypesAction } from "@/app/admin/leave-types/actions";

export const metadata: Metadata = { title: "Leave types · Admin · OOOhm" };

function summary(t: LeaveTypeRow): string {
  const parts = [t.isPaid ? "Paid" : "Unpaid"];
  if (!t.countsAgainstAllowance) parts.push("no limit");
  else parts.push(t.defaultAllowanceDays === null ? "allowance set per person" : `${formatDays(t.defaultAllowanceDays)} a year`);
  if (t.countsAgainstAllowance && t.carryoverEnabled) {
    parts.push(t.carryoverMaxDays === null ? "unused days carry over" : `up to ${formatDays(t.carryoverMaxDays)} carry over`);
  }
  return parts.join(" · ");
}

function Chip({ t }: { t: LeaveTypeRow }) {
  const color = normalizeHexColor(t.color);
  return (
    <span className="rounded-md px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: color, color: readableTextColor(color) }}>
      {t.code}
    </span>
  );
}

export default async function LeaveTypesPage() {
  const { actor, ctx, nav } = await requireAdminPage();
  const types = await listLeaveTypesForAdmin(ctx, actor);
  const active = types.filter((t) => t.archivedAt === null);
  const archived = types.filter((t) => t.archivedAt !== null);

  return (
    <AdminShell
      nav={nav}
      section="leave-types"
      title="Leave types"
      description="What people can ask for, in the order the request form lists them: drag a row by its handle to move it. The first one is the form's default. Archived types leave the form but stay on past requests and balances."
      action={
        <Link href="/admin/leave-types/new" className={primaryButton}>
          Add leave type
        </Link>
      }
    >
      {active.length === 0 ? (
        <p className="text-muted">No active leave types: nobody can request time off until you add one.</p>
      ) : (
        <SortableList
          label="Leave types, in the order of the request form"
          reorder={reorderLeaveTypesAction}
          items={active.map((t) => ({
            id: t.id,
            label: t.name,
            content: (
              // Wraps rather than squeezing: when Archive opens its question, the question
              // takes its own line under the name instead of crowding the name column.
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                <div className="min-w-0 space-y-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    <Chip t={t} />
                    <Link href={`/admin/leave-types/${t.id}`} className={cx(textLink, "break-words")}>
                      {t.name}
                    </Link>
                  </p>
                  <p className="text-sm text-muted">{summary(t)}</p>
                </div>
                <div className="max-w-full">
                  <InlineAction
                    action={archiveLeaveTypeAction}
                    fields={{ id: t.id, archived: "true" }}
                    label="Archive"
                    ariaLabel={`Archive ${t.name}`}
                    pendingLabel="Archiving…"
                    variant="danger"
                    confirm={`Archive ${t.name}? Nobody can request it any more; past requests and balances keep it.`}
                    confirmLabel="Yes, archive"
                  />
                </div>
              </div>
            ),
          }))}
        />
      )}

      {archived.length > 0 && (
        // Closed by default: archived types are rarely needed, so they stay out of sight until asked for.
        <details className="group">
          <summary className={cx(subtleButton, "w-fit cursor-pointer gap-1.5 list-none [&::-webkit-details-marker]:hidden")}>
            <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90">
              <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {/* A heading inside the summary keeps the section in screen readers' heading list. */}
            <h2>Archived ({archived.length})</h2>
          </summary>
          <ItemList className="mt-3">
            {archived.map((t) => (
              <Item key={t.id} className="flex flex-wrap items-center justify-between gap-3">
                <p className="flex flex-wrap items-center gap-2 text-muted">
                  <Chip t={t} />
                  {t.name}
                </p>
                <InlineAction
                  action={archiveLeaveTypeAction}
                  fields={{ id: t.id, archived: "false" }}
                  label="Restore"
                  ariaLabel={`Restore ${t.name}`}
                  pendingLabel="Restoring…"
                  variant="outline"
                />
              </Item>
            ))}
          </ItemList>
        </details>
      )}
    </AdminShell>
  );
}
