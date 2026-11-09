import Link from "next/link";
import type { AgendaItem, CalendarViewEntry } from "@/domain/calendar";
import { formatLeaveDates } from "@/lib/format";
import { StatusBadge } from "@/components/leave/status-badge";
import { Item } from "@/components/ui/card";
import { ColorLabel } from "@/components/ui/color-label";

/** One line of the month as a list: a holiday, or leave that opens the request (or, for a colleague, their page). */
export function AgendaRow({ item }: { item: AgendaItem<CalendarViewEntry> }) {
  if (item.kind === "holiday") {
    return (
      <Item className="flex flex-col gap-1 text-muted">
        <span>{formatLeaveDates(item.date, item.date)}</span>
        <span className="text-sm">{item.name} · Company holiday</span>
      </Item>
    );
  }
  const { entry } = item;
  // The whole row opens the request (or, for a colleague, their page): its dates are the link, stretched over the row.
  return (
    <Item className="relative flex items-start justify-between gap-3 transition-colors hover:bg-background">
      <div className="min-w-0 space-y-1">
        <ColorLabel color={entry.leaveTypeColor} className="font-medium">
          <Link
            href={entry.isMine ? `/requests/${entry.id}` : `/team/${entry.userId}`}
            aria-label={
              entry.isMine
                ? undefined
                : `${entry.personName}, ${formatLeaveDates(entry.startDate, entry.endDate, entry.dayPortion)}, ${entry.leaveTypeName}: open their page`
            }
            className="outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent-ink"
          >
            {formatLeaveDates(entry.startDate, entry.endDate, entry.dayPortion)}
          </Link>
        </ColorLabel>
        <p className="text-sm text-muted">{entry.isMine ? entry.leaveTypeName : `${entry.personName} · ${entry.leaveTypeName}`}</p>
      </div>
      {entry.status === "pending" && <StatusBadge status="pending" />}
    </Item>
  );
}
