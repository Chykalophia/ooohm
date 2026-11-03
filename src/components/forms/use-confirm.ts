"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The "ask first" step of an action that is hard to undo: the first click asks a
 * question ("Revoke this key?"), "Yes, …" sends it, "Keep it" backs out. Focus moves to
 * the question when it appears and back to the button that asked when the person backs
 * out, so keyboard users never lose their place.
 *
 * `T` names what is being asked when one place offers several such actions (a calendar
 * link can be replaced or turned off).
 *
 * @returns `asking` (what is being asked, or `null`), `ask(what)`, `back()` and
 *   `done()` (ends the question without moving focus, e.g. after the action ran), plus
 *   refs for the question and for each opener button.
 */
export function useConfirm<T extends string = "confirm">() {
  const [asking, setAsking] = useState<T | null>(null);
  const questionRef = useRef<HTMLParagraphElement>(null);
  const openers = useRef(new Map<T, HTMLButtonElement>());

  useEffect(() => {
    if (asking !== null) questionRef.current?.focus();
  }, [asking]);

  return {
    asking,
    ask: (what: T) => setAsking(what),
    back: () => {
      const what = asking;
      setAsking(null);
      // The opener mounts again on the next frame; focus it then.
      if (what !== null) requestAnimationFrame(() => openers.current.get(what)?.focus());
    },
    done: () => setAsking(null),
    questionRef,
    /** Ref for the button that asks `what`, so focus can return to it. */
    openerRef: (what: T) => (el: HTMLButtonElement | null) => {
      if (el) openers.current.set(what, el);
      else openers.current.delete(what);
    },
  };
}
