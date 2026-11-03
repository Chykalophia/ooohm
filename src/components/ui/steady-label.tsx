import { cx } from "./styles";

/**
 * Text that turns bold (the current page's link, an open menu's button) without
 * changing width, so the items beside it never shift. A hidden bold copy sits in the
 * same grid cell and holds the bold width at all times; screen readers skip it.
 *
 * @param truncate Cut long text with an ellipsis at the parent's width (a long name).
 */
export function SteadyLabel({ bold, truncate = false, children }: { bold: boolean; truncate?: boolean; children: React.ReactNode }) {
  const cell = cx("col-start-1 row-start-1", truncate && "min-w-0 truncate");
  return (
    <span className={cx("inline-grid", truncate && "min-w-0")}>
      <span className={cx(cell, bold && "font-medium")}>{children}</span>
      <span aria-hidden className={cx(cell, "invisible select-none font-medium")}>
        {children}
      </span>
    </span>
  );
}
