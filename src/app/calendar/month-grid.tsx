"use client";

import { useEffect, useRef, useState } from "react";
import { fromEpochDay, toEpochDay } from "@/domain/calendar-date";
import type { CalendarDay } from "@/domain/calendar";
import { formatLeaveDates, formatLongDate } from "@/lib/format";
import { LeaveChip } from "@/app/leave-chip";
import { type LeaveTypeOption, LeavePreviewLine, SubmitRow, useLeavePreview, useRequestAction } from "@/app/request-leave-form";

const WEEKDAYS = [
  ["Mon", "Monday"],
  ["Tue", "Tuesday"],
  ["Wed", "Wednesday"],
  ["Thu", "Thursday"],
  ["Fri", "Friday"],
  ["Sat", "Saturday"],
  ["Sun", "Sunday"],
] as const;

/** Faint diagonal hatching over the page background: a day that cannot cost leave. */
const OFF_DAY = "bg-background bg-[repeating-linear-gradient(135deg,var(--color-border)_0_1px,transparent_1px_7px)]";

/**
 * This month's working days are plain, its weekends and holidays are hatched, and the
 * neighbouring months' days have no fill and a faded number, so the three never look
 * alike. A selected day takes a light accent tint over any of them.
 */
function dayStyle(day: CalendarDay, selected: boolean): { cell: string; number: string } {
  const number = !day.inMonth ? "text-muted opacity-60" : !day.isWorkingDay || day.holiday !== null ? "text-muted" : "text-foreground";
  if (selected) return { cell: "bg-accent/15", number };
  if (!day.inMonth) return { cell: "bg-transparent", number };
  if (!day.isWorkingDay || day.holiday !== null) return { cell: OFF_DAY, number };
  return { cell: "bg-surface", number };
}

/** What a screen reader hears for a day: its date, then anything on it. */
function dayLabel(day: CalendarDay): string {
  const parts = [formatLongDate(day.date)];
  if (day.isToday) parts.push("today");
  if (day.holiday) parts.push(`${day.holiday}, company holiday`);
  else if (!day.isWorkingDay) parts.push("not a working day");
  for (const e of day.entries) parts.push(`${e.leaveTypeName}${e.status === "pending" ? ", waiting for approval" : ""}`);
  return parts.join(", ");
}

type Range = { start: string; end: string };

function ordered(a: string, b: string): Range {
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

/**
 * The month grid, which doubles as a way to ask for time off: drag across days (or
 * click one, then shift-click another) and a short form appears under the month with
 * the dates, the live day count and a Request button. With a keyboard, arrow keys move
 * between days, Enter or Space picks one, and Shift with an arrow stretches the pick.
 * Phones get the agenda instead; the form on Home works everywhere.
 */
export function MonthGrid({ weeks, caption, leaveTypes }: { weeks: CalendarDay[][]; caption: string; leaveTypes: LeaveTypeOption[] }) {
  const days = weeks.flat();
  const [anchor, setAnchor] = useState<string | null>(null);
  const [end, setEnd] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [focusDate, setFocusDate] = useState(() => (days.find((d) => d.isToday) ?? days.find((d) => d.inMonth) ?? days[0])?.date ?? "");
  const cells = useRef(new Map<string, HTMLButtonElement>());
  const range = anchor && end ? ordered(anchor, end) : null;
  const canRequest = leaveTypes.length > 0;
  const { state, formAction, pending } = useRequestAction();
  const [sentId, setSentId] = useState<string | null>(null);

  // A request that went through clears the pick; its outcome shows until the next pick.
  if (state.status === "success" && state.id !== sentId) {
    setSentId(state.id);
    setAnchor(null);
    setEnd(null);
  }

  useEffect(() => {
    if (!dragging) return;
    const stop = () => setDragging(false);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [dragging]);

  function pick(date: string, extend: boolean) {
    if (extend && anchor) setEnd(date);
    else {
      setAnchor(date);
      setEnd(date);
    }
  }

  function moveFocus(date: string) {
    if (!cells.current.has(date)) return;
    setFocusDate(date);
    cells.current.get(date)?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent, date: string) {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      const next = fromEpochDay(toEpochDay(date) + step);
      if (!cells.current.has(next)) return;
      moveFocus(next);
      if (e.shiftKey && canRequest) {
        if (!anchor) setAnchor(date);
        setEnd(next);
      }
    } else if (e.key === "Escape" && range) {
      e.preventDefault();
      setAnchor(null);
      setEnd(null);
    }
  }

  return (
    <div className="space-y-4">
      <table className="w-full table-fixed border-separate border-spacing-0 overflow-hidden rounded-2xl border border-border">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {WEEKDAYS.map(([short, long]) => (
              <th key={short} scope="col" className="border-b border-border bg-surface px-2 py-2 text-left text-xs font-medium tracking-wide text-muted uppercase">
                <abbr title={long} className="no-underline">
                  {short}
                </abbr>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, w) => (
            <tr key={week[0]?.date ?? w}>
              {week.map((day, d) => {
                const selected = range !== null && day.date >= range.start && day.date <= range.end;
                const style = dayStyle(day, selected);
                const edges = `${d < 6 ? "border-r" : ""} ${w < weeks.length - 1 ? "border-b" : ""}`;
                return (
                  <td key={day.date} className={`h-24 border-border p-0 align-top ${edges} ${style.cell}`}>
                    <button
                      type="button"
                      ref={(el) => {
                        if (el) cells.current.set(day.date, el);
                        else cells.current.delete(day.date);
                      }}
                      tabIndex={day.date === focusDate ? 0 : -1}
                      aria-label={dayLabel(day)}
                      aria-pressed={canRequest ? selected : undefined}
                      onPointerDown={(e) => {
                        if (!canRequest || e.button !== 0) return;
                        setFocusDate(day.date);
                        pick(day.date, e.shiftKey);
                        setDragging(true);
                        // Let the pointer move over other cells without the browser capturing it here.
                        (e.target as Element).releasePointerCapture?.(e.pointerId);
                      }}
                      onPointerEnter={() => {
                        if (dragging) setEnd(day.date);
                      }}
                      onClick={(e) => {
                        // Keyboard activation (Enter or Space) reports no pointer detail.
                        if (e.detail === 0 && canRequest) pick(day.date, e.shiftKey);
                      }}
                      onKeyDown={(e) => onKeyDown(e, day.date)}
                      onFocus={() => setFocusDate(day.date)}
                      className={`flex h-full min-h-24 w-full flex-col gap-1 p-1.5 text-left select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-ink ${
                        canRequest ? "cursor-pointer hover:bg-accent/5" : "cursor-default"
                      }`}
                    >
                      <span
                        className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs tabular-nums ${
                          day.isToday ? "bg-accent font-semibold text-accent-foreground" : style.number
                        }`}
                      >
                        {Number(day.date.slice(8))}
                      </span>
                      {day.holiday && (
                        <span className="truncate text-xs text-muted" title={day.holiday}>
                          {day.holiday}
                        </span>
                      )}
                      {day.entries.map((entry) => (
                        <LeaveChip key={entry.id} entry={entry} />
                      ))}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {canRequest && !range && (
        <p aria-live="polite" className="text-sm">
          {state.status === "success" ? (
            <span className="text-accent-ink">{state.message}</span>
          ) : (
            <span className="text-muted">Drag across days, or pick one and Shift-click another, to ask for time off.</span>
          )}
        </p>
      )}
      {canRequest && range && (
        <RequestFromRange
          range={range}
          leaveTypes={leaveTypes}
          action={{ state, formAction, pending }}
          onClear={() => {
            setAnchor(null);
            setEnd(null);
          }}
        />
      )}
    </div>
  );
}

/** The short form under the month for the picked days: type, live count, Request. */
function RequestFromRange({
  range,
  leaveTypes,
  action,
  onClear,
}: {
  range: Range;
  leaveTypes: LeaveTypeOption[];
  action: Pick<ReturnType<typeof useRequestAction>, "state" | "formAction" | "pending">;
  onClear: () => void;
}) {
  const { state, formAction, pending } = action;
  const [leaveTypeId, setLeaveTypeId] = useState(leaveTypes[0]?.id ?? "");
  const preview = useLeavePreview({ leaveTypeId, startDate: range.start, endDate: range.end, dayPortion: "full" });

  return (
    <section aria-label="Ask for these days" className="space-y-3 rounded-2xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">{formatLeaveDates(range.start, range.end)}</p>
        <button
          type="button"
          onClick={onClear}
          className="rounded-md text-sm text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink"
        >
          Clear
        </button>
      </div>
      <LeavePreviewLine preview={preview} />
      <form action={formAction} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="startDate" value={range.start} />
        <input type="hidden" name="endDate" value={range.end} />
        <input type="hidden" name="dayPortion" value="full" />
        <label className="flex items-center gap-2 text-sm">
          <span className="sr-only">Type of leave</span>
          <select
            name="leaveTypeId"
            required
            value={leaveTypeId}
            onChange={(e) => setLeaveTypeId(e.target.value)}
            className="rounded-lg border border-border bg-surface px-3 py-2 outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          >
            {leaveTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <SubmitRow state={state} pending={pending} label="Request" />
      </form>
    </section>
  );
}
