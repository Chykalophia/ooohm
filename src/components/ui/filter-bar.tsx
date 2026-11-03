"use client";

import Form from "next/form";
import Link from "next/link";
import { outlineButton, subtleButton } from "./styles";
import { useFilterForm } from "./use-filter-form";

/**
 * A search form that filters the list below it through the page's query string, so a
 * filtered view can be bookmarked and Back works. Its fields are the children; Filter
 * and Clear (shown once something is filtered) follow them. It navigates in place
 * (`next/form`), and without JavaScript it is a plain GET form. A new filter always
 * starts at page 1: the page's cursor is not a field, so it is dropped. The fields follow
 * the URL and leave empties out of it ({@link useFilterForm}).
 *
 * @param path The list's page: where the form submits, and what Clear leads back to.
 * @param autoApply Apply each change as it is made (see {@link useFilterForm}). Filter
 *   stays, for no-JS.
 * @param className The layout of the fields (a wrapping row, a grid).
 */
export function FilterBar({
  label,
  path,
  filtered,
  autoApply = false,
  className,
  children,
}: {
  label: string;
  path: string;
  filtered: boolean;
  autoApply?: boolean;
  className: string;
  children: React.ReactNode;
}) {
  const form = useFilterForm(autoApply);
  return (
    <Form action={path} role="search" aria-label={label} className={className} {...form}>
      {children}
      <div className="flex items-center gap-4 self-end">
        <button type="submit" className={outlineButton}>
          Filter
        </button>
        {filtered && (
          <Link href={path} className={subtleButton}>
            Clear
          </Link>
        )}
      </div>
    </Form>
  );
}
