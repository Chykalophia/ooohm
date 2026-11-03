"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

/** How long typing in a search box pauses before the search runs. */
const SEARCH_DELAY_MS = 350;

/**
 * Leaves empty fields out of the URL (`?action=&actor=` reads as noise): they are
 * disabled for the moment `next/form` reads the form, which it does right after this
 * handler, then enabled again. Some engines move focus off a field as it is disabled; a
 * focused one gets focus back.
 */
function omitEmpty(e: React.FormEvent<HTMLFormElement>) {
  markSent(e.currentTarget);
  const empty = [...e.currentTarget.elements].filter(
    (el): el is HTMLInputElement | HTMLSelectElement =>
      (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) && el.name !== "" && el.value === "" && !el.disabled,
  );
  const focused = document.activeElement;
  for (const el of empty) el.disabled = true;
  setTimeout(() => {
    empty.forEach((el) => (el.disabled = false));
    if (focused instanceof HTMLElement && empty.includes(focused as HTMLInputElement) && document.activeElement !== focused) {
      focused.focus({ preventScroll: true });
    }
  });
}

const TYPED = "input[type=search], input[type=text]";

/**
 * A field someone has typed in since the form last went out: the URL, which is older,
 * must not overwrite it under their cursor. A focused field whose text did go out (and
 * whose filter was then removed, say by its chip) follows the URL like the rest.
 */
function isTyping(el: Element): boolean {
  return (
    el === document.activeElement &&
    el instanceof HTMLInputElement &&
    el.matches(TYPED) &&
    el.value !== (el.dataset.sent ?? el.defaultValue)
  );
}

/** Notes what each text field held when the form went out, for {@link isTyping}. */
function markSent(form: HTMLFormElement) {
  for (const el of form.querySelectorAll<HTMLInputElement>(TYPED)) el.dataset.sent = el.value;
}

/**
 * Sets each named field to the URL's value for it ("" when absent), and its default too
 * (dates compare against it). A value with no option (a person since deleted) shows the
 * "any" option instead of a blank.
 */
function showParams(form: HTMLFormElement, params: URLSearchParams) {
  for (const el of form.elements) {
    if (isTyping(el)) continue;
    if (el instanceof HTMLInputElement && el.type === "checkbox") {
      el.checked = el.defaultChecked = params.getAll(el.name).includes(el.value);
    } else if ((el instanceof HTMLInputElement && el.type !== "hidden") || el instanceof HTMLSelectElement) {
      let value = params.get(el.name) ?? "";
      // A hand-edited URL can hold more than the field takes; setting .value skips maxLength.
      if (el instanceof HTMLInputElement && el.maxLength > 0) value = value.slice(0, el.maxLength);
      // A date being typed holds "" until it is whole; only its default (what blur compares
      // against) follows the URL, so the digits typed so far stay.
      if (el instanceof HTMLInputElement && el.type === "date" && el === document.activeElement) {
        el.defaultValue = value;
        continue;
      }
      el.value = value;
      if (el instanceof HTMLSelectElement && el.value !== value) el.value = "";
      if (el instanceof HTMLInputElement) {
        el.defaultValue = value;
        if (el.matches(TYPED)) el.dataset.sent = value;
      }
    }
  }
}

/**
 * The behaviour of a GET filter form rendered with `next/form`, as props to spread on it:
 *
 * - The fields always show the filters in force: whenever the URL changes (a filter link,
 *   Clear, Back) they take its values, in place rather than remounted, so keyboard focus
 *   stays on the field just changed, and never under someone's cursor while they type.
 * - Empty fields stay out of the URL.
 * - With `autoApply`, each change applies as it is made: a picked option or box at once,
 *   a date once its field is left (date inputs report a change on every keystroke while
 *   a year is typed), a search after a short pause in typing, or at once when the search
 *   box is left (so a link clicked meanwhile, which blurs it first, navigates last).
 */
export function useFilterForm(autoApply: boolean) {
  const params = useSearchParams();
  const ref = useRef<HTMLFormElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cancelSearch = () => {
    clearTimeout(searchTimer.current);
    searchTimer.current = undefined;
  };

  useEffect(() => {
    if (ref.current) showParams(ref.current, params);
  }, [params]);
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  if (!autoApply) return { ref, onSubmit: omitEmpty };
  return {
    ref,
    onSubmit(e: React.FormEvent<HTMLFormElement>) {
      cancelSearch();
      omitEmpty(e);
    },
    onChange(e: React.FormEvent<HTMLFormElement>) {
      if ((e.target as HTMLElement).matches("select, input[type=checkbox]")) e.currentTarget.requestSubmit();
    },
    onInput(e: React.FormEvent<HTMLFormElement>) {
      if (!(e.target as HTMLElement).matches("input[type=search]")) return;
      const form = e.currentTarget;
      cancelSearch();
      searchTimer.current = setTimeout(() => {
        searchTimer.current = undefined;
        form.requestSubmit();
      }, SEARCH_DELAY_MS);
    },
    onBlur(e: React.FocusEvent<HTMLFormElement>) {
      const field = e.target;
      if (field instanceof HTMLInputElement && field.type === "search" && searchTimer.current !== undefined)
        e.currentTarget.requestSubmit();
      if (field instanceof HTMLInputElement && field.type === "date" && field.value !== field.defaultValue) e.currentTarget.requestSubmit();
    },
  };
}
