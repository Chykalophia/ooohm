import type { Metadata } from "next";
import Link from "next/link";
import { normalizeHexColor, readableTextColor } from "@/lib/color";
import { formatDays } from "@/lib/format";
import { type LeaveTypeRow, listLeaveTypesForAdmin } from "@/server/services/admin-leave-types";
import { AdminShell } from "@/app/admin/admin-shell";
import { requireAdminPage } from "@/app/_lib/page-context";
import { Item, ItemList } from "@/components/ui/card";
import { InlineAction } from "@/components/forms/inline-action";
import { cx, outlineButton, primaryButton, subtleButton, textLink } from "@/components/ui/styles";
import { Section } from "@/components/ui/section";
import { archiveLeaveTypeAction, moveLeaveTypeAction } from "@/app/admin/leave-types/actions";

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
  const move = cx(subtleButton, "px-2 py-1");

  return (
    <AdminShell
      nav={nav}
      section="leave-types"
      title="Leave types"
      description="What people can ask for. The first one is the request form's default. Archived types leave the form but stay on past requests and balances."
      action={
        <Link href="/admin/leave-types/new" className={primaryButton}>
          Add leave type
        </Link>
      }
    >
      {active.length === 0 ? (
        <p className="text-muted">No active leave types: nobody can request time off until you add one.</p>
      ) : (
        <ItemList ordered>
          {active.map((t, i) => (
            <Item key={t.id} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  <Chip t={t} />
                  <Link href={`/admin/leave-types/${t.id}`} className={cx(textLink, "break-words")}>
                    {t.name}
                  </Link>
                </p>
                <p className="text-sm text-muted">{summary(t)}</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {i > 0 && (
                  <InlineAction
                    action={moveLeaveTypeAction}
                    fields={{ id: t.id, direction: "up" }}
                    label="↑ Up"
                    ariaLabel={`Move ${t.name} up`}
                    pendingLabel="Moving…"
                    className={move}
                    showSuccess={false}
                  />
                )}
                {i < active.length - 1 && (
                  <InlineAction
                    action={moveLeaveTypeAction}
                    fields={{ id: t.id, direction: "down" }}
                    label="↓ Down"
                    ariaLabel={`Move ${t.name} down`}
                    pendingLabel="Moving…"
                    className={move}
                    showSuccess={false}
                  />
                )}
                <InlineAction
                  action={archiveLeaveTypeAction}
                  fields={{ id: t.id, archived: "true" }}
                  label="Archive"
                  ariaLabel={`Archive ${t.name}`}
                  pendingLabel="Archiving…"
                  danger
                  confirm={`Archive ${t.name}? Nobody can request it any more; past requests and balances keep it.`}
                  confirmLabel="Yes, archive"
                />
              </div>
            </Item>
          ))}
        </ItemList>
      )}

      {archived.length > 0 && (
        <Section title="Archived" className="space-y-3">
          <ItemList>
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
                  className={outlineButton}
                />
              </Item>
            ))}
          </ItemList>
        </Section>
      )}
    </AdminShell>
  );
}
