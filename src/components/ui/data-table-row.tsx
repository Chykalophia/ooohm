"use client";

import { useId, useState } from "react";
import { cx, focusRing, tableCell } from "./styles";

/** How many columns a full-width cell spans: all of them, and those showing on a phone. */
export type RowSpans = { all: number; phone: number };

/**
 * A cell across the whole row. With columns hidden on phones it is two cells, one per
 * width, only one of them displayed, so it never spans hidden columns (that adds phantom
 * columns, which squeeze the real ones). The hidden copy is `display: none`, so screen
 * readers meet the content once.
 */
export function SpanningCell({ spans, className, children }: { spans: RowSpans; className?: string; children: React.ReactNode }) {
  if (spans.all === spans.phone) {
    return (
      <td colSpan={spans.all} className={className}>
        {children}
      </td>
    );
  }
  return (
    <>
      <td colSpan={spans.phone} className={cx("sm:hidden", className)}>
        {children}
      </td>
      <td colSpan={spans.all} className={cx("hidden sm:table-cell", className)}>
        {children}
      </td>
    </>
  );
}

/** Clicks on these act on themselves, never open or close the row. */
const OWN_CLICK = "a, button, input, select, textarea, label, summary";

/**
 * One row of a {@link DataTable}, with its detail row underneath. The chevron is the
 * keyboard and screen reader control (`aria-expanded`); a click anywhere else on the row
 * does the same, unless it lands on a link or control in a cell, or ends a text
 * selection. The detail row is always rendered, `hidden` while closed, so the chevron's
 * `aria-controls` names a real element.
 *
 * @param expandable The table has a details column: a row without `detail` still
 *   fills it, empty, so the columns line up.
 */
export function DataTableRow({
  cells,
  label,
  detail,
  expandable,
  spans,
}: {
  cells: { content: React.ReactNode; className?: string }[];
  label: string;
  detail: React.ReactNode;
  expandable: boolean;
  spans: RowSpans;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const opens = detail !== null && detail !== undefined;

  function onRowClick(e: React.MouseEvent<HTMLTableRowElement>) {
    if (!opens || (e.target as Element).closest(OWN_CLICK)) return;
    if (window.getSelection()?.toString()) return;
    setOpen((o) => !o);
  }

  return (
    <>
      <tr
        onClick={onRowClick}
        className={cx("[&:first-child>td]:border-t-0", opens && "cursor-pointer hover:bg-background", open && "bg-background")}
      >
        {cells.map((c, i) => (
          <td key={i} className={cx(tableCell, c.className)}>
            {c.content}
          </td>
        ))}
        {expandable && (
          <td className={cx(tableCell, "w-10 text-right")}>
            {opens && (
              <button
                type="button"
                aria-expanded={open}
                aria-controls={detailId}
                aria-label={`Details: ${label}`}
                onClick={() => setOpen((o) => !o)}
                // -my-0.5 keeps the padded button within one text line, so the row stays as tall as the others.
                className={cx("-my-0.5 rounded-md p-1 text-muted hover:text-foreground", focusRing)}
              >
                <svg
                  aria-hidden
                  viewBox="0 0 20 20"
                  className={cx("h-4 w-4 transition-transform", open && "rotate-180")}
                  fill="currentColor"
                >
                  <path d="M5.25 7.5 10 12.25 14.75 7.5z" />
                </svg>
              </button>
            )}
          </td>
        )}
      </tr>
      {opens && (
        <tr id={detailId} hidden={!open} className="bg-background">
          <SpanningCell spans={spans} className="px-4 pt-1 pb-4">
            {detail}
          </SpanningCell>
        </tr>
      )}
    </>
  );
}
