"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cx } from "./styles";

export type ChipOption = {
  value: string;
  label: string;
  disabled?: boolean;
  /** A colour dot beside the label (a leave type's). */ color?: string;
};

/**
 * A choice inside a sentence: the chip shows the current label, and a click opens a small
 * menu of options right under it, at the page's normal text size whatever the sentence's.
 * Replaces a native `<select>`, whose menu copies the select's (large) font. The value is
 * posted from a hidden input named `name`.
 *
 * Keyboard: Enter, Space or the arrow keys open it; arrows, Home and End move; Enter or
 * Space picks; Escape or Tab closes. Focus stays on the listbox while it is open
 * (`aria-activedescendant`) and returns to the chip on close.
 */
export function ChipSelect({
  name,
  label,
  value,
  options,
  onChange,
  className,
  children,
}: {
  name: string;
  /** What the choice is, for screen readers ("Type of leave"). */
  label: string;
  value: string;
  options: readonly ChipOption[];
  onChange: (value: string) => void;
  /** The chip's own look (the sentence's token). */
  className?: string;
  /** What the chip shows: the current choice, usually with a caret. */
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLSpanElement>(null);
  const id = useId();
  const current = options.find((o) => o.value === value);

  // Clicking anywhere else closes it, as a native menu does.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  useEffect(() => {
    if (open) list.current?.focus();
  }, [open]);

  function show() {
    const selected = options.findIndex((o) => o.value === value);
    setActive(selected >= 0 ? selected : firstEnabled(options, 0, 1));
    setOpen(true);
  }

  function close(refocus = true) {
    setOpen(false);
    if (refocus) button.current?.focus();
  }

  function pick(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    close();
  }

  function onListKey(e: React.KeyboardEvent) {
    const move = (from: number, step: 1 | -1) => {
      e.preventDefault();
      setActive(firstEnabled(options, from, step));
    };
    if (e.key === "ArrowDown") move(active + 1, 1);
    else if (e.key === "ArrowUp") move(active - 1, -1);
    else if (e.key === "Home") move(0, 1);
    else if (e.key === "End") move(options.length - 1, -1);
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") close(false);
  }

  return (
    <span ref={root} className={cx("relative", className)}>
      <button
        ref={button}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${current?.label ?? "none"}`}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            show();
          }
        }}
        className="cursor-pointer outline-none"
      >
        {children}
      </button>
      <input type="hidden" name={name} value={value} />
      {open && (
        // Spans, not a list: the chip lives inside a sentence's <p>, where <ul> is invalid HTML.
        <span
          ref={list}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={`${id}-${active}`}
          onKeyDown={onListKey}
          className={cx(
            "absolute top-full left-0 z-30 mt-2 block max-h-72 min-w-full overflow-y-auto rounded-xl border border-border bg-surface p-1",
            "text-left text-base leading-normal font-normal tracking-normal whitespace-nowrap text-foreground shadow-lg outline-none",
          )}
        >
          {options.map((o, i) => {
            const selected = o.value === value;
            return (
              <span
                key={o.value}
                id={`${id}-${i}`}
                role="option"
                aria-selected={selected}
                aria-disabled={o.disabled || undefined}
                onPointerEnter={() => !o.disabled && setActive(i)}
                onClick={() => pick(i)}
                className={cx(
                  "flex items-center gap-2.5 rounded-lg py-2 pr-4 pl-2.5",
                  o.disabled ? "cursor-default text-muted opacity-60" : "cursor-pointer",
                  i === active && !o.disabled && "bg-accent/10",
                )}
              >
                <Check visible={selected} />
                {o.color && <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: o.color }} />}
                <span className={cx(selected && "font-medium text-accent-ink")}>{o.label}</span>
              </span>
            );
          })}
        </span>
      )}
    </span>
  );
}

/** The next enabled option from `from`, going `step`, wrapping; `from` itself when none is. */
function firstEnabled(options: readonly ChipOption[], from: number, step: 1 | -1): number {
  const n = options.length;
  for (let k = 0; k < n; k++) {
    const i = (((from + k * step) % n) + n) % n;
    if (!options[i]?.disabled) return i;
  }
  return Math.max(0, Math.min(from, n - 1));
}

function Check({ visible }: { visible: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={cx("h-4 w-4 shrink-0 text-accent-ink", !visible && "invisible")}>
      <path
        d="M3.5 8.5 6.5 11.5 12.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
