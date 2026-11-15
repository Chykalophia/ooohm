"use client";

import { useEffect, useRef, useState } from "react";
import { fromEpochDay, toEpochDay } from "@/domain/calendar-date";

export type Range = { start: string; end: string };

function ordered(a: string, b: string): Range {
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

/**
 * The month grid's day picking: drag across days, click a first and a last day, or use
 * the arrow keys with Enter, Space or Shift. Holds the pick, the roving tab stop and the
 * day buttons, and hands each cell and button its handlers.
 *
 * @param dates The grid's days, in order.
 * @param firstFocus The day that takes the tab stop until another is focused.
 * @param canPick Whether days can be picked at all (the company has a leave type).
 */
export function useDayPicker(dates: readonly string[], firstFocus: string, canPick: boolean) {
  const [anchor, setAnchor] = useState<string | null>(null);
  const [end, setEnd] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [focusDate, setFocusDate] = useState(firstFocus);
  // After moving to another month the old date is gone; the tab stop falls back to the new month's.
  const tabStop = dates.includes(focusDate) ? focusDate : firstFocus;
  const cells = useRef(new Map<string, HTMLButtonElement>());
  // How the last press started: a touch only picks on its click, so scrolling past a day never picks it.
  const pointerType = useRef("mouse");
  // A press that stretched a single pick: if it turns into a drag, the drag starts afresh here.
  const pressedAt = useRef<string | null>(null);
  const range = anchor && end ? ordered(anchor, end) : null;

  useEffect(() => {
    if (!dragging) return;
    const stop = () => setDragging(false);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [dragging]);

  function clear() {
    setAnchor(null);
    setEnd(null);
  }

  // With one day picked, picking another stretches to it, so a range needs neither a drag
  // nor Shift (WCAG 2.5.7). A pick after a range starts again. Returns whether it stretched
  // a single pick (rather than Shift extending, or starting afresh).
  function pick(date: string, extend: boolean): boolean {
    const single = anchor !== null && anchor === end && date !== anchor;
    if ((extend || single) && anchor) {
      setEnd(date);
      return single && !extend;
    }
    setAnchor(date);
    setEnd(date);
    return false;
  }

  function moveFocus(date: string) {
    if (!cells.current.has(date)) return;
    setFocusDate(date);
    cells.current.get(date)?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent, date: string) {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      const next = fromEpochDay(toEpochDay(date) + step);
      if (!cells.current.has(next)) return;
      moveFocus(next);
      if (e.shiftKey && canPick) {
        if (!anchor) setAnchor(date);
        setEnd(next);
      }
    } else if (e.key === "Escape" && range) {
      e.preventDefault();
      clear();
    }
  }

  /** The cell's own handler: dragging across a day's leave chips still stretches the pick. */
  function onCellPointerEnter(date: string) {
    if (!dragging) return;
    // Dragging on from a press that stretched a single pick: the drag is a new range.
    if (pressedAt.current && pressedAt.current !== date) {
      setAnchor(pressedAt.current);
      pressedAt.current = null;
    }
    setEnd(date);
  }

  /** The props of a day's button, which fills its cell behind the cell's content. */
  function dayButton(date: string) {
    return {
      ref: (el: HTMLButtonElement | null) => {
        if (el) cells.current.set(date, el);
        else cells.current.delete(date);
      },
      tabIndex: date === tabStop ? 0 : -1,
      onPointerDown: (e: React.PointerEvent) => {
        pointerType.current = e.pointerType;
        if (!canPick || e.button !== 0 || e.pointerType === "touch") return;
        setFocusDate(date);
        pressedAt.current = pick(date, e.shiftKey) ? date : null;
        setDragging(true);
        // Let the pointer move over other cells without the browser capturing it here.
        (e.target as Element).releasePointerCapture?.(e.pointerId);
      },
      onClick: (e: React.MouseEvent) => {
        // Keyboard activation (Enter or Space) reports no pointer detail; a tap picks here too.
        if (canPick && (e.detail === 0 || pointerType.current === "touch")) pick(date, e.shiftKey);
      },
      onKeyDown: (e: React.KeyboardEvent) => onKeyDown(e, date),
      onFocus: () => setFocusDate(date),
    };
  }

  return { range, clear, onKeyDown, onCellPointerEnter, dayButton };
}
