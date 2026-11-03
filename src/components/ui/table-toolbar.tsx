"use client";

import Form from "next/form";
import Link from "next/link";
import { useId, useRef, useState } from "react";
import { buttonClass, cx, fieldClass, focusRing } from "./styles";
import { useFilterForm } from "./use-filter-form";

/** A filter in force, shown as a chip that removes it. */
export type ActiveFilter = { label: string; value: string; removeHref: string };

/**
 * The bar across the top of a {@link DataTable}: a search box, a Filters button that
 * opens the table's filter fields, an `aside` (rows a page), and the filters in force as
 * chips, each removable on its own, with Clear all. Everything applies as it changes
 * ({@link useFilterForm}): the search after a pause in typing, a picked option at once,
 * a date when its field is left. Enter searches at once.
 *
 * It submits the page's query string in place (`next/form`), so a view can be
 * bookmarked and Back works, and starts again at page 1. The Filters panel stays as it
 * was across those navigations. Removing a chip (or Clear all) puts focus in the search
 * box, since the chip itself is gone.
 *
 * @param search The search box's field name, value in force and placeholder.
 * @param filters The panel's fields (compact `size="sm"` fields), laid out in a grid.
 * @param activeFilterCount How many filters (not the search) are in force, for the
 *   button's badge.
 * @param keep Hidden fields the form carries unchanged: the view (order, rows a page).
 * @param clearHref Clear all: no search or filters, the view kept.
 */
export function TableToolbar({
  label,
  path,
  search,
  filters,
  activeFilterCount,
  active,
  aside,
  keep,
  clearHref,
}: {
  label: string;
  path: string;
  search: { name: string; value: string; placeholder: string };
  filters: React.ReactNode;
  activeFilterCount: number;
  active: readonly ActiveFilter[];
  aside?: React.ReactNode;
  keep?: Record<string, string | undefined>;
  clearHref: string;
}) {
  const form = useFilterForm(true);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const searchId = useId();
  const searchBox = useRef<HTMLInputElement>(null);
  // A removed chip leaves the page; focus moves to the search box rather than the page's top.
  const refocus = () => searchBox.current?.focus();

  return (
    <div className="space-y-3 border-b border-border p-3">
      <Form action={path} role="search" aria-label={label} className="space-y-3" {...form}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-48 flex-1">
            <label htmlFor={searchId} className="sr-only">
              Search
            </label>
            <svg
              aria-hidden
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted"
            >
              <circle cx="8.5" cy="8.5" r="5.25" />
              <path d="m12.5 12.5 4 4" strokeLinecap="round" />
            </svg>
            <input
              ref={searchBox}
              id={searchId}
              type="search"
              name={search.name}
              defaultValue={search.value}
              placeholder={search.placeholder}
              maxLength={100}
              autoComplete="off"
              className={cx(fieldClass("sm"), "pl-8")}
            />
          </div>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((o) => !o)}
            className={cx(buttonClass("outline", "sm"), "gap-1.5")}
          >
            <svg aria-hidden viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-4 w-4">
              <path d="M3.5 5.5h13M6 10h8M8.5 14.5h3" strokeLinecap="round" />
            </svg>
            Filters
            {activeFilterCount > 0 && (
              <span className="rounded-full bg-accent px-1.5 text-xs font-medium text-accent-foreground tabular-nums">
                {activeFilterCount}
                <span className="sr-only"> in use</span>
              </span>
            )}
          </button>
          {aside && <div className="ml-auto">{aside}</div>}
          {/* Lets Enter submit at once, from any field; without JavaScript, the only way to. */}
          <button type="submit" hidden>
            Search
          </button>
        </div>
        <div id={panelId} hidden={!open} className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {filters}
        </div>
        {Object.entries(keep ?? {}).map(([name, value]) => value && <input key={name} type="hidden" name={name} value={value} />)}
      </Form>

      {active.length > 0 && (
        <ul aria-label="Filters in use" className="flex flex-wrap items-center gap-2">
          {active.map((f) => (
            <li key={f.label}>
              <Link
                href={f.removeHref}
                onClick={refocus}
                aria-label={`Remove ${f.label}: ${f.value}`}
                className={cx(
                  "inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-background py-0.5 pr-1.5 pl-2.5 text-xs hover:border-foreground/30",
                  focusRing,
                )}
              >
                <span className="text-muted">{f.label}:</span>
                <span className="truncate font-medium">{f.value}</span>
                <svg aria-hidden viewBox="0 0 20 20" className="h-3.5 w-3.5 text-muted" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m6 6 8 8M14 6l-8 8" strokeLinecap="round" />
                </svg>
              </Link>
            </li>
          ))}
          <li>
            <Link href={clearHref} onClick={refocus} className={cx("rounded-md text-xs text-muted hover:text-foreground", focusRing)}>
              Clear all
            </Link>
          </li>
        </ul>
      )}
    </div>
  );
}
