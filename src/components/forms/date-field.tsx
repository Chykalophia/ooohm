"use client";

import type { CalendarDate } from "@/domain/calendar-date";
import { FieldShell } from "@/components/ui/fields";
import { cx, fieldClass } from "@/components/ui/styles";
import { DatePicker } from "./date-picker";

/**
 * A labelled date field for a form: the label above, and a field-shaped button showing
 * the date in words that opens the themed {@link DatePicker}. Posts `name` as
 * `YYYY-MM-DD` and is required. While the calendar is open the field keeps its focus
 * border, so it stays clear which date is being picked.
 */
export function DateField({
  label,
  pickerLabel,
  name,
  value,
  min,
  onChange,
  className,
}: {
  /** The visible label ("From"). */
  label: string;
  /** What the date is ("First day"): names the calendar and its typed field. */
  pickerLabel?: string;
  name: string;
  value: CalendarDate | "";
  /** Days before it show but can't be picked. */
  min?: CalendarDate;
  onChange: (value: CalendarDate) => void;
  /** Classes for the wrapper, e.g. to size the field in a grid. */
  className?: string;
}) {
  return (
    <FieldShell
      label={label}
      className={className}
      control={({ id }) => (
        <DatePicker
          id={id}
          name={name}
          label={label}
          pickerLabel={pickerLabel}
          value={value}
          min={min}
          onChange={onChange}
          rootClassName="block"
          className={cx(
            fieldClass(),
            "flex items-center justify-between gap-2 text-left tabular-nums",
            "aria-expanded:border-accent-ink aria-expanded:ring-2 aria-expanded:ring-accent-ink/20",
          )}
          adornment={<CalendarIcon />}
        />
      )}
    />
  );
}

function CalendarIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-muted">
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
