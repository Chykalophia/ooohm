import type { CalendarEntry } from "@/domain/calendar";
import { feedEventSummary } from "@/domain/calendar-feed";
import { normalizeHexColor, readableTextColor } from "@/lib/color";

/**
 * One request inside a calendar day. Approved leave is a solid chip in the leave
 * type's colour; pending leave is an outline in that colour and says "pending" in its
 * label, so the difference never rests on colour alone. Labels match the calendar
 * feeds: "PTO", "PTO (AM)", "PTO (pending)".
 */
export function LeaveChip({ entry }: { entry: CalendarEntry }) {
  const color = normalizeHexColor(entry.leaveTypeColor);
  const label = feedEventSummary(entry);
  const pending = entry.status === "pending";
  return (
    <span
      title={`${entry.leaveTypeName}${pending ? ", waiting for approval" : ""}`}
      className={`block rounded-md px-1.5 py-0.5 text-xs leading-snug font-medium break-words ${pending ? "border border-dashed text-foreground" : ""}`}
      style={pending ? { borderColor: color } : { backgroundColor: color, color: readableTextColor(color) }}
    >
      {label}
      <span className="sr-only">
        {`, ${entry.leaveTypeName}, ${pending ? "waiting for approval" : "approved"}`}
      </span>
    </span>
  );
}
