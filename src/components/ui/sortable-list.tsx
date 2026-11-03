"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useLayoutEffect, useRef, useState, useTransition } from "react";
import { ErrorMessage } from "@/components/forms/form-status";
import type { FormState } from "@/components/forms/form-state";
import { moveTo, sameOrder, slotFor } from "./sortable-order";
import { cx, focusRing, surface } from "./styles";

/** One row of a {@link SortableList}: its id, its name (for the handle and announcements) and what it shows. */
export type SortableItem = { id: string; label: string; content: React.ReactNode };

type Drag = { id: string; by: "pointer" | "keyboard"; from: string[] };

/** How long a row takes to slide into its new place while another is dragged past it. */
const SLIDE_MS = 150;

/**
 * A list whose order is changed by dragging, saved on drop with `reorder(ids)`. The
 * page renders each row's `content` (links and actions included); this list adds a
 * drag handle in front of each and keeps the order.
 *
 * - Pointer (mouse, pen or touch): drag a row by its handle. It follows the pointer, and
 *   the others slide out of its way as it passes their middles. Releasing saves.
 * - Keyboard: focus a handle and press Space or Enter to pick the row up, the arrow keys
 *   (Home, End) to move it, Space or Enter to drop it and save, Escape to put it back.
 *   Each step is announced, and focus stays on the handle.
 *
 * While a save runs the handles are inert. A refused save puts the order back as the
 * server has it, says why, and refreshes the page; a saved one is announced, and the
 * server's order (refreshed with it) takes over.
 *
 * @param label Names the list for screen readers ("Leave types, in the order of the request form").
 */
export function SortableList({
  items,
  label,
  reorder,
}: {
  items: readonly SortableItem[];
  label: string;
  reorder: (ids: string[]) => Promise<FormState>;
}) {
  const router = useRouter();
  const instructionsId = useId();
  const byId = new Map(items.map((item) => [item.id, item]));
  const serverOrder = items.map((item) => item.id);

  // The order shown: the server's, until someone drags; it follows the server again
  // whenever the server's order changes (after a save, or someone else's).
  const serverKey = serverOrder.join(",");
  const [shownFor, setShownFor] = useState(serverKey);
  const [order, setOrder] = useState(serverOrder);
  if (shownFor !== serverKey) {
    setShownFor(serverKey);
    setOrder(serverOrder);
  }

  const [drag, setDrag] = useState<Drag | null>(null);
  // The drag as of the last render, for checks that run a frame later (blur).
  const latestDrag = useRef<Drag | null>(null);
  useEffect(() => {
    latestDrag.current = drag;
  }, [drag]);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [saving, startSaving] = useTransition();

  const rows = useRef(new Map<string, HTMLLIElement>());
  const handles = useRef(new Map<string, HTMLButtonElement>());
  // Pointer drags: where the pointer is, where it held the row, and how far the row is
  // shifted from its place in the list.
  const pointer = useRef({ y: 0, grab: 0, shift: 0 });
  // Each row's top before the last move, so the others can slide from there.
  const tops = useRef(new Map<string, number>());

  const position = (ids: readonly string[], id: string) => `position ${ids.indexOf(id) + 1} of ${ids.length}`;
  const nameOf = (id: string) => byId.get(id)?.label ?? "Item";

  /** Moves `id` to `to`, remembering where every row was, for the slide. */
  function move(id: string, to: number) {
    const next = moveTo(order, id, to);
    if (sameOrder(next, order)) return order;
    for (const [rowId, row] of rows.current) tops.current.set(rowId, row.getBoundingClientRect().top);
    setOrder(next);
    return next;
  }

  /** Shifts the dragged row so it sits under the pointer, wherever its place in the list now is. */
  function placeUnderPointer(id: string) {
    const row = rows.current.get(id);
    if (!row) return;
    const slotTop = row.getBoundingClientRect().top - pointer.current.shift;
    pointer.current.shift = pointer.current.y - pointer.current.grab - slotTop;
    row.style.transform = `translateY(${pointer.current.shift}px)`;
  }

  // After a move: the dragged row is put back under the pointer (its place changed), the
  // keyboard's handle keeps focus (moving a node can blur it), and the others slide from
  // where they were.
  useLayoutEffect(() => {
    if (!drag) return;
    if (drag.by === "pointer") placeUnderPointer(drag.id);
    else if (document.activeElement !== handles.current.get(drag.id)) handles.current.get(drag.id)?.focus();
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const [id, row] of rows.current) {
      const before = tops.current.get(id);
      if (id === drag.id || before === undefined || still) continue;
      const dy = before - row.getBoundingClientRect().top;
      if (dy === 0) continue;
      row.style.transition = "none";
      row.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => {
        row.style.transition = `transform ${SLIDE_MS}ms ease`;
        row.style.transform = "";
      });
    }
    tops.current.clear();
    // Runs after each move; `drag` is read, not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order]);

  function release(id: string) {
    const row = rows.current.get(id);
    if (row) {
      row.style.transform = "";
      row.style.transition = "";
    }
    pointer.current.shift = 0;
  }

  function save(id: string, from: string[], to: string[]) {
    setDrag(null);
    if (sameOrder(from, to)) {
      setAnnouncement(`${nameOf(id)} dropped where it was.`);
      return;
    }
    setError(null);
    startSaving(async () => {
      const result = await reorder(to);
      if (result.status === "error") {
        setOrder(from);
        setError(result.message);
        setAnnouncement(`Not saved. ${result.message}`);
        router.refresh();
      } else {
        setAnnouncement(`Saved. ${nameOf(id)} is at ${position(to, id)}.`);
      }
    });
  }

  function cancel(current: Drag) {
    setDrag(null);
    setOrder(current.from);
    setAnnouncement(`Cancelled. ${nameOf(current.id)} is back at ${position(current.from, current.id)}.`);
  }

  // Pointer.
  function onPointerDown(e: React.PointerEvent<HTMLButtonElement>, id: string) {
    if (saving || drag || e.button !== 0) return;
    const row = rows.current.get(id);
    if (!row) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    pointer.current = { y: e.clientY, grab: e.clientY - row.getBoundingClientRect().top, shift: 0 };
    // A row still sliding from a move would trail the pointer.
    row.style.transition = "none";
    setError(null);
    setDrag({ id, by: "pointer", from: order });
  }

  function onPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    if (drag?.by !== "pointer") return;
    pointer.current.y = e.clientY;
    placeUnderPointer(drag.id);
    const row = rows.current.get(drag.id);
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const others = order
      .filter((id) => id !== drag.id)
      .map((id) => {
        const r = rows.current.get(id)!.getBoundingClientRect();
        return r.top + r.height / 2;
      });
    move(drag.id, slotFor(rect.top + rect.height / 2, others));
  }

  function onPointerEnd(e: React.PointerEvent<HTMLButtonElement>, cancelled: boolean) {
    if (drag?.by !== "pointer") return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    release(drag.id);
    if (cancelled) cancel(drag);
    else save(drag.id, drag.from, order);
  }

  // Keyboard.
  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, id: string) {
    const picked = drag?.by === "keyboard" && drag.id === id ? drag : null;
    if (!picked) {
      if ((e.key === " " || e.key === "Enter") && !saving && !drag) {
        e.preventDefault();
        setError(null);
        setDrag({ id, by: "keyboard", from: order });
        setAnnouncement(`Picked up ${nameOf(id)}, ${position(order, id)}. Arrow keys move it, Space drops it, Escape cancels.`);
      }
      return;
    }
    const at = order.indexOf(id);
    const to = { ArrowUp: at - 1, ArrowDown: at + 1, Home: 0, End: order.length - 1 }[e.key];
    if (to !== undefined) {
      e.preventDefault();
      const next = move(id, to);
      setAnnouncement(`${nameOf(id)}, ${position(next, id)}.`);
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      save(id, picked.from, order);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel(picked);
    }
  }

  // Leaving the handle mid-move puts the row back. Checked a frame later: a move can blur
  // the handle for a moment before the effect above focuses it again.
  function onBlur(id: string) {
    requestAnimationFrame(() => {
      const current = latestDrag.current;
      if (current?.by !== "keyboard" || current.id !== id || document.activeElement === handles.current.get(id)) return;
      cancel(current);
    });
  }

  return (
    <div className="space-y-2">
      <p id={instructionsId} className="sr-only">
        Drag a row by its handle to move it. With the keyboard: Space picks it up, the arrow keys move it, Space drops it, Escape cancels.
      </p>
      <ol aria-label={label} className={cx("divide-y divide-border", surface)}>
        {order.map((id) => {
          const item = byId.get(id);
          if (!item) return null;
          const lifted = drag?.id === id;
          return (
            <li
              key={id}
              ref={(el) => {
                if (el) rows.current.set(id, el);
                else rows.current.delete(id);
              }}
              className={cx(
                "relative flex items-center gap-3 bg-surface py-4 pr-4 pl-2 first:rounded-t-2xl last:rounded-b-2xl",
                lifted && "z-10 rounded-2xl shadow-lg ring-1 ring-border",
              )}
            >
              <button
                type="button"
                ref={(el) => {
                  if (el) handles.current.set(id, el);
                  else handles.current.delete(id);
                }}
                aria-label={`Move ${item.label}`}
                aria-describedby={instructionsId}
                aria-disabled={saving}
                onPointerDown={(e) => onPointerDown(e, id)}
                onPointerMove={onPointerMove}
                onPointerUp={(e) => onPointerEnd(e, false)}
                onPointerCancel={(e) => onPointerEnd(e, true)}
                onKeyDown={(e) => onKeyDown(e, id)}
                onBlur={() => onBlur(id)}
                className={cx(
                  "shrink-0 touch-none rounded-md p-1.5 text-muted hover:text-foreground aria-disabled:opacity-60",
                  lifted ? "cursor-grabbing text-foreground" : "cursor-grab",
                  focusRing,
                )}
              >
                <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor">
                  {[6, 10, 14].flatMap((y) => [7, 13].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.5" />))}
                </svg>
              </button>
              <div className="min-w-0 flex-1">{item.content}</div>
            </li>
          );
        })}
      </ol>
      <p aria-live="assertive" className="sr-only">
        {announcement}
      </p>
      {saving && <p className="text-sm text-muted">Saving the order…</p>}
      {error && (
        <ErrorMessage as="p" className="text-sm">
          {error}
        </ErrorMessage>
      )}
    </div>
  );
}
