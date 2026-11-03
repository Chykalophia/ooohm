import { DataTableRow } from "./data-table-row";
import { cx, surface, tableHeadCell } from "./styles";

/** One column of a {@link DataTable}. */
export type Column<T> = {
  /** The header: text, or a control such as a sort link. */
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  /** The column's cells' own classes: width, alignment, wrapping. */
  className?: string;
  /** Hidden on phone widths, to keep one line a row; show what it holds in the row's detail too. */
  hideOnPhone?: boolean;
  /** How the rows are sorted by this column, for `aria-sort`. */
  sort?: "ascending" | "descending";
};

/**
 * A dense table for long records (the audit log): one line a row, a header that stays in
 * view while the rows scroll, and, when `detail` is given, rows that open to show
 * everything about them, by a click on the row or its chevron. Renders on the server;
 * only opening a row runs in the browser ({@link DataTableRow}).
 *
 * @param caption What the table lists, for screen readers.
 * @param rowLabel A row's name for its chevron's label ("Details: Person edited, Nov 2").
 * @param detail The open row's content, or `null` for a row with nothing more to show.
 * @param toolbar A bar inside the table's card, above its header (a `TableToolbar`).
 * @param fixed Columns keep the widths their `className`s give (the rest share what is
 *   left) instead of following the content, so they never shift between pages or
 *   filters. Cells then cut long text with an ellipsis.
 * @param empty What the table says when it has no rows; the toolbar and header stay, so
 *   a search that finds nothing can be changed in place.
 */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  rowLabel,
  detail,
  toolbar,
  fixed = false,
  empty = "Nothing to show.",
}: {
  caption: string;
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  rowLabel: (row: T) => string;
  detail?: (row: T) => React.ReactNode;
  toolbar?: React.ReactNode;
  fixed?: boolean;
  empty?: React.ReactNode;
}) {
  const phone = (c: Column<T>) => c.hideOnPhone && "hidden sm:table-cell";
  return (
    // `overflow-clip`, not `hidden`: it rounds the corners without becoming a scroll
    // container, which would stop the header sticking to the page.
    <div className={cx(surface, "overflow-clip")}>
      {toolbar}
      <table className={cx("w-full border-separate border-spacing-0 text-sm", fixed && "table-fixed")}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} scope="col" aria-sort={c.sort} className={cx(tableHeadCell, phone(c), c.className)}>
                {c.header}
              </th>
            ))}
            {detail && (
              <th scope="col" className={cx(tableHeadCell, "w-10")}>
                <span className="sr-only">Details</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length + (detail ? 1 : 0)} className="px-4 py-8 text-center text-muted">
                {empty}
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <DataTableRow
              key={rowKey(row)}
              cells={columns.map((c) => ({ content: c.cell(row), className: cx(phone(c), c.className) }))}
              label={rowLabel(row)}
              detail={detail ? detail(row) : null}
              expandable={detail !== undefined}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
