"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export type JumpItem = { href: string; label: string };

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * ⌘K (Ctrl+K elsewhere) opens a small list of the screens this person can reach: type
 * to filter, arrows to move, Enter to go. Nothing shows until someone presses the keys,
 * so newcomers never meet it. A native `<dialog>`, so focus stays inside and Escape
 * closes it.
 */
export function JumpMenu({ items }: { items: JumpItem[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const matches = items.filter((i) => i.label.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // In a text field the keys keep their own meaning (Ctrl+K deletes to the line's end on a Mac).
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k" && !isTyping(e.target)) {
        e.preventDefault();
        setQuery("");
        setActive(0);
        if (!dialog.current?.open) dialog.current?.showModal();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function go(item: JumpItem | undefined) {
    if (!item) return;
    dialog.current?.close();
    router.push(item.href);
  }

  return (
    <dialog
      ref={dialog}
      aria-label="Go to"
      onClick={(e) => {
        // A click on the backdrop (the dialog itself, outside its panel) closes it.
        if (e.target === dialog.current) dialog.current.close();
      }}
      className="m-auto mt-[15vh] w-[min(28rem,calc(100vw-2rem))] rounded-2xl border border-border bg-surface p-0 text-foreground shadow-xl backdrop:bg-foreground/20"
    >
      <div className="p-2">
        <input
          autoFocus
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, matches.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              go(matches[active]);
            }
          }}
          placeholder="Go to…"
          aria-label="Go to"
          aria-controls="jump-list"
          aria-activedescendant={matches[active] ? `jump-${matches[active].href}` : undefined}
          role="combobox"
          aria-expanded
          className="w-full rounded-lg border border-border bg-background px-3 py-2 outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
        <ul id="jump-list" role="listbox" aria-label="Screens" className="mt-2 max-h-72 overflow-y-auto">
          {matches.length === 0 && (
            <li role="option" aria-selected={false} aria-disabled="true" className="px-3 py-2 text-sm text-muted">
              Nothing matches.
            </li>
          )}
          {matches.map((item, i) => (
            <li
              key={item.href}
              id={`jump-${item.href}`}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(item)}
              className={`cursor-pointer rounded-lg px-3 py-2 text-sm ${i === active ? "bg-accent/10 text-accent-ink" : ""}`}
            >
              {item.label}
            </li>
          ))}
        </ul>
      </div>
      <p className="border-t border-border px-4 py-2 text-xs text-muted">On Approvals: J and K move between requests, A approves, D declines with a reason.</p>
    </dialog>
  );
}
