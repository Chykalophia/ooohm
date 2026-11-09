"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CalendarDate } from "@/domain/calendar-date";
import { monthOf } from "@/domain/calendar";
import { formatShortDay } from "@/lib/format";
import { cx, errorText, focusRing } from "@/components/ui/styles";
import { initialFocus, isGridKey, isSelectable, localToday, moveFocus, parseTyped, pickerGrid } from "./date-picker-grid";

const longFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});
const monthFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long" });

function longDay(date: CalendarDate): string {
  const [y, m, d] = date.split("-").map(Number);
  return longFormat.format(new Date(Date.UTC(y, m - 1, d)));
}

function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return monthFormat.format(new Date(Date.UTC(y, m - 1, 1)));
}

const WEEKDAYS = [
  ["Mon", "Monday"],
  ["Tue", "Tuesday"],
  ["Wed", "Wednesday"],
  ["Thu", "Thursday"],
  ["Fri", "Friday"],
  ["Sat", "Saturday"],
  ["Sun", "Sunday"],
] as const;

/** Space kept between the popup and the viewport's edges, in CSS px (1rem). */
const EDGE = 16;

/**
 * A date chosen from a themed calendar popup instead of the browser's own. The trigger
 * shows the date in words; a click, Enter or Space opens a dialog with a typed
 * `YYYY-MM-DD` field, month navigation, a Monday-first grid and a "Today" button. The
 * grid follows the WAI-ARIA date picker dialog pattern (arrows, Home/End, PageUp/PageDown,
 * Shift for years). The value is posted as `name`, `YYYY-MM-DD`, and is required.
 *
 * Inside a sentence's `<p>`, so it is built of spans and buttons only. Colours are theme
 * tokens; the popup sits under the trigger and, on phones, spans the card's width.
 */
export function DatePicker({
  name,
  label,
  value,
  min,
  onChange,
  className,
}: {
  name: string;
  /** What the date is ("First day"): names the trigger, the dialog and the typed field. */
  label: string;
  value: CalendarDate | "";
  /** Days before it show but can't be picked. */
  min?: CalendarDate;
  onChange: (value: CalendarDate) => void;
  /** The trigger's own look (the sentence's token). */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState<CalendarDate>("");
  const [today, setToday] = useState<CalendarDate>("");
  const [typed, setTyped] = useState("");
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLSpanElement>(null);
  const typedField = useRef<HTMLInputElement>(null);
  const prevButton = useRef<HTMLButtonElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const todayButton = useRef<HTMLButtonElement>(null);
  /** Set when focus should follow the focused day (opening, grid keys), not stay where it is. */
  const focusGrid = useRef(false);
  const id = useId();

  const typedDate = parseTyped(typed);
  const typedInvalid = typed.length > 0 && !(typedDate && isSelectable(typedDate, min));
  const todayAllowed = today !== "" && isSelectable(today, min);

  // A pointer-down anywhere else closes it, leaving the value as it was.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (root.current?.contains(e.target as Node)) return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  useEffect(() => {
    if (!open || !focusGrid.current) return;
    focusGrid.current = false;
    popup.current?.querySelector<HTMLElement>(`[data-date="${focus}"]`)?.focus();
  }, [open, focus]);

  // Under the trigger, kept inside the viewport; on phones, the sentence card's width and left edge.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const wrap = root.current;
      const panel = popup.current;
      if (!wrap || !panel) return;
      const viewport = document.documentElement.clientWidth;
      const anchor = wrap.getBoundingClientRect().left;
      const phone = !window.matchMedia("(min-width: 40rem)").matches;
      // Phones: exactly the card's box (the nearest section), never wider than the viewport.
      const card = phone ? (wrap.closest("section") ?? wrap.closest("form")) : null;
      const box = card?.getBoundingClientRect();
      const width = box ? Math.min(box.width, viewport) : 0;
      panel.style.width = box ? `${width}px` : "";
      const left = box
        ? Math.max(0, Math.min(box.left, viewport - width))
        : Math.max(EDGE, Math.min(anchor, viewport - EDGE - panel.offsetWidth));
      panel.style.left = `${left - anchor}px`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  function show() {
    const now = localToday();
    setToday(now);
    setTyped(value);
    setFocus(initialFocus(value, now, min));
    focusGrid.current = true;
    setOpen(true);
  }

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  function pick(date: CalendarDate) {
    if (!isSelectable(date, min)) return;
    onChange(date);
    close();
  }

  function onType(text: string) {
    setTyped(text);
    const date = parseTyped(text);
    if (date && isSelectable(date, min)) {
      onChange(date);
      setFocus(date);
    }
  }

  function turnMonth(step: 1 | -1) {
    setFocus((f) => moveFocus(f, step > 0 ? "PageDown" : "PageUp"));
  }

  function onGridKey(e: React.KeyboardEvent) {
    if (isGridKey(e.key)) {
      e.preventDefault();
      focusGrid.current = true;
      setFocus((f) => moveFocus(f, e.key as Parameters<typeof moveFocus>[1], e.shiftKey));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(focus);
    }
  }

  // Tab and Shift+Tab stay inside the dialog: typed field, previous, next, grid, Today.
  function onDialogKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const day = popup.current?.querySelector<HTMLElement>('[data-date][tabindex="0"]');
    const stops = [typedField.current, prevButton.current, nextButton.current, day, todayAllowed ? todayButton.current : null].filter(
      (el): el is HTMLElement => !!el,
    );
    const at = stops.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    stops[(at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
  }

  const month = focus ? monthOf(focus) : "";
  const year = month.slice(0, 4);
  const days = month ? pickerGrid(month) : [];

  return (
    <span ref={root} className="relative inline-block max-w-full">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}, ${value ? longDay(value) : "no date"}`}
        onClick={() => (open ? close() : show())}
        className={cx("cursor-pointer", focusRing, className)}
      >
        {value ? formatShortDay(value) : "pick a date"}
      </button>
      {/* The posted value. A real (invisible) input, so `required` still blocks an empty submit. */}
      <input
        name={name}
        value={value}
        required
        tabIndex={-1}
        aria-hidden
        onChange={() => {}}
        className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
      />
      {open && month && (
        <span
          ref={popup}
          role="dialog"
          aria-modal="true"
          aria-label={`Choose ${label.toLowerCase()}`}
          onKeyDown={onDialogKey}
          style={{ fontFamily: "var(--app-font)" }}
          className={cx(
            "absolute top-full z-30 mt-2.5 block w-[min(20rem,calc(100vw-2rem))] max-sm:w-[calc(100vw-2rem)]",
            "rounded-2xl border border-border bg-surface p-4 pb-3 shadow-lg max-sm:p-3 max-sm:pb-2",
            "text-left text-base leading-normal font-normal tracking-normal whitespace-normal text-foreground",
          )}
        >
          <span className="mb-3 flex flex-wrap items-baseline gap-x-2">
            <label htmlFor={`${id}-typed`} className="text-xs tracking-[0.06em] text-muted uppercase">
              {label}
            </label>
            <input
              ref={typedField}
              id={`${id}-typed`}
              value={typed}
              onChange={(e) => onType(e.target.value)}
              inputMode="numeric"
              placeholder="YYYY-MM-DD"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={typedInvalid || undefined}
              aria-describedby={typedInvalid ? `${id}-error` : undefined}
              className={cx(
                "min-w-0 flex-1 rounded-none border-0 border-b border-field bg-transparent px-0 py-0.5 text-base tabular-nums outline-none sm:text-sm",
                "focus:border-b-2 focus:border-accent-ink aria-[invalid=true]:border-danger",
              )}
            />
            {typedInvalid && (
              <span id={`${id}-error`} className={cx("basis-full text-xs", errorText)}>
                Use YYYY-MM-DD{min ? `, on or after ${formatShortDay(min)}` : ""}.
              </span>
            )}
          </span>

          <span className="mb-2 flex items-center justify-between">
            <span
              aria-live="polite"
              style={{ fontFamily: "var(--display-font)" }}
              className="text-2xl leading-tight font-semibold tracking-[-0.01em] max-sm:text-xl"
            >
              {monthName(month)} <span className="font-normal text-muted">{year}</span>
            </span>
            <span className="flex">
              <NavButton ref={prevButton} label="Previous month" onClick={() => turnMonth(-1)} direction={-1} />
              <NavButton ref={nextButton} label="Next month" onClick={() => turnMonth(1)} direction={1} />
            </span>
          </span>

          <span role="grid" aria-label={`${monthName(month)} ${year}`} onKeyDown={onGridKey} className="block">
            <span role="row" className="grid grid-cols-7 py-1 text-center text-[0.6875rem] tracking-[0.06em] text-muted uppercase">
              {WEEKDAYS.map(([short, full]) => (
                <span key={short} role="columnheader" aria-label={full}>
                  <abbr title={full} className="no-underline">
                    {short}
                  </abbr>
                </span>
              ))}
            </span>
            {Array.from({ length: 6 }, (_, row) => (
              <span key={row} role="row" className="grid grid-cols-7">
                {days
                  .slice(row * 7, row * 7 + 7)
                  .map((day) => (
                    <DayCell
                      key={day.date}
                      date={day.date}
                      inMonth={day.inMonth}
                      selected={day.date === value}
                      isToday={day.date === today}
                      disabled={!isSelectable(day.date, min)}
                      focused={day.date === focus}
                      onPick={() => pick(day.date)}
                    />
                  ))}
              </span>
            ))}
          </span>

          <span className="mt-2 flex border-t border-dashed border-border pt-2">
            <button
              ref={todayButton}
              type="button"
              disabled={!todayAllowed}
              onClick={() => pick(today)}
              className={cx(
                "-ml-1.5 cursor-pointer rounded-md px-1.5 py-1 text-sm font-medium text-accent-ink underline-offset-4 hover:underline",
                "disabled:cursor-default disabled:no-underline disabled:opacity-60",
                focusRing,
              )}
            >
              Today <span className="text-muted">· {formatShortDay(today)}</span>
            </button>
          </span>
        </span>
      )}
    </span>
  );
}

function DayCell({
  date,
  inMonth,
  selected,
  isToday,
  disabled,
  focused,
  onPick,
}: {
  date: CalendarDate;
  inMonth: boolean;
  selected: boolean;
  isToday: boolean;
  disabled: boolean;
  focused: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="gridcell"
      data-date={date}
      tabIndex={focused ? 0 : -1}
      aria-label={`${longDay(date)}${isToday ? ", today" : ""}`}
      aria-selected={selected || undefined}
      aria-disabled={disabled || undefined}
      onClick={onPick}
      className={cx(
        "relative grid aspect-square min-h-9 place-items-center rounded-lg text-[0.9375rem] tabular-nums",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ink",
        selected
          ? "bg-accent font-semibold text-accent-foreground forced-colors:outline-2 forced-colors:-outline-offset-2 forced-colors:outline-[Highlight]"
          : disabled
            ? "cursor-default text-muted line-through opacity-50"
            : cx("cursor-pointer hover:bg-accent/10 hover:text-accent-ink", inMonth ? "text-foreground" : "text-muted"),
      )}
    >
      <span className={cx(isToday && "font-bold", isToday && !selected && !disabled && "text-accent-ink")}>{Number(date.slice(8))}</span>
      {isToday && (
        <span
          aria-hidden
          className={cx(
            "absolute bottom-[22%] left-1/2 h-0.5 w-4 -translate-x-1/2 rounded-sm",
            selected ? "bg-accent-foreground" : "bg-accent-ink",
            "forced-colors:bg-[CanvasText]",
          )}
        />
      )}
    </button>
  );
}

function NavButton({
  ref,
  label,
  direction,
  onClick,
}: {
  ref: React.Ref<HTMLButtonElement>;
  label: string;
  direction: 1 | -1;
  onClick: () => void;
}) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cx("grid size-10 cursor-pointer place-items-center rounded-(--button-radius) text-accent-ink hover:bg-accent/10", focusRing)}
    >
      <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4">
        <path
          d={direction < 0 ? "M10 3.5 5.5 8 10 12.5" : "M6 3.5 10.5 8 6 12.5"}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
