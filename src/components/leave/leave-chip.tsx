import Link from "next/link";
import type { CalendarEntry } from "@/domain/calendar";
import { feedEventSummary } from "@/domain/calendar-feed";
import { normalizeHexColor, readableTextColor } from "@/lib/color";
import { cx, focusRing } from "@/components/ui/styles";

/**
 * One request inside a calendar day. Approved leave is a solid chip in the leave
 * type's colour; pending leave is an outline in that colour and says "pending" in its
 * label, so the difference never rests on colour alone. Labels match the calendar
 * feeds: "PTO", "PTO (AM)", "PTO (pending)".
 *
 * @param href Where the chip leads (the request's own page, for the person's own
 *   leave): it becomes a link that lifts its shadow and outline on hover.
 */
export function LeaveChip({ entry, href }: { entry: CalendarEntry; href?: string }) {
  const color = normalizeHexColor(entry.leaveTypeColor);
  const label = feedEventSummary(entry);
  const pending = entry.status === "pending";
  const className = cx(
    "block min-h-6 rounded-md px-1.5 py-1 text-xs leading-snug font-medium break-words",
    pending && "border border-dashed text-foreground",
    href && "transition hover:shadow-md hover:ring-2 hover:ring-foreground/20 motion-safe:hover:-translate-y-px",
    href && focusRing,
  );
  const style = pending ? { borderColor: color } : { backgroundColor: color, color: readableTextColor(color) };
  const content = (
    <>
      {label}
      <span className="sr-only">{`, ${entry.leaveTypeName}, ${pending ? "waiting for approval" : "approved"}`}</span>
    </>
  );
  const title = `${entry.leaveTypeName}${pending ? ", waiting for approval" : ""}`;
  return href ? (
    <Link href={href} title={`${title}: open the request`} className={className} style={style}>
      {content}
    </Link>
  ) : (
    <span title={title} className={className} style={style}>
      {content}
    </span>
  );
}
