"use client";

import Form from "next/form";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { outlineButton, subtleButton } from "./styles";

/** A picked option or a ticked box applies at once. */
function applyPicked(e: React.FormEvent<HTMLFormElement>) {
  if ((e.target as HTMLElement).matches("select, input[type=checkbox]")) e.currentTarget.requestSubmit();
}

/**
 * A date applies when the field is left with a new value: date inputs report a change on
 * every keystroke while a year is typed, which would reload the list mid-word.
 */
function applyTyped(e: React.FocusEvent<HTMLFormElement>) {
  const field = e.target;
  if (field instanceof HTMLInputElement && field.type === "date" && field.value !== field.defaultValue) e.currentTarget.requestSubmit();
}

/**
 * Leaves empty fields out of the URL (`?action=&actor=` reads as noise): they are
 * disabled for the moment `next/form` reads the form, which it does right after this
 * handler, then enabled again.
 */
function omitEmpty(e: React.FormEvent<HTMLFormElement>) {
  const empty = [...e.currentTarget.elements].filter(
    (el): el is HTMLInputElement | HTMLSelectElement =>
      (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) && el.name !== "" && el.value === "" && !el.disabled,
  );
  for (const el of empty) el.disabled = true;
  setTimeout(() => empty.forEach((el) => (el.disabled = false)));
}

/** Sets each named field to the URL's value for it ("" when absent); defaults too, for {@link applyTyped}. */
function showParams(form: HTMLFormElement, params: URLSearchParams) {
  for (const el of form.elements) {
    if (el instanceof HTMLInputElement && el.type === "checkbox") {
      el.checked = el.defaultChecked = params.getAll(el.name).includes(el.value);
    } else if ((el instanceof HTMLInputElement && el.type !== "hidden") || el instanceof HTMLSelectElement) {
      const value = params.get(el.name) ?? "";
      el.value = value;
      // A value with no option (a person since deleted) shows the "any" option instead of a blank.
      if (el instanceof HTMLSelectElement && el.value !== value) el.value = "";
      if (el instanceof HTMLInputElement) el.defaultValue = value;
    }
  }
}

/**
 * A search form that filters the list below it through the page's query string, so a
 * filtered view can be bookmarked and Back works. Its fields are the children; Filter
 * and Clear (shown once something is filtered) follow them. It navigates in place
 * (`next/form`), and without JavaScript it is a plain GET form. A new filter always
 * starts at page 1: the page's cursor is not a field, so it is dropped. Whenever the
 * URL changes (a filter link in the list, Clear, Back) the fields take its values, so
 * they always show the filters in force. They are updated in place, not remounted, so
 * keyboard focus stays on the field just changed.
 *
 * @param path The list's page: where the form submits, and what Clear leads back to.
 * @param autoApply Apply each change as it is made: a picked option or box at once, a
 *   date once its field is left. Filter stays, for text and for no-JS.
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
  const params = useSearchParams();
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (form.current) showParams(form.current, params);
  }, [params]);
  return (
    <Form
      ref={form}
      action={path}
      role="search"
      aria-label={label}
      className={className}
      onChange={autoApply ? applyPicked : undefined}
      onBlur={autoApply ? applyTyped : undefined}
      onSubmit={omitEmpty}
    >
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
