"use client";

import { useEffect, useSyncExternalStore } from "react";
import { nativeCheck } from "@/components/ui/styles";

/** The event a decision form listens for to start a decline with a reason. */
export const DECLINE_EVENT = "approval:decline";

/** Where the person's choice is kept, per browser. */
const STORAGE_KEY = "ooohm:approval-keys";
/** Fired in this tab when the choice changes (`storage` only fires in other tabs). */
const CHANGE_EVENT = "ooohm:approval-keys";

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function readEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

function setEnabled(on: boolean) {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * Keyboard shortcuts for the Approvals list, for people who decide a lot: J and K move
 * between requests, A approves the one in focus, D starts declining it (focus moves to
 * its reason; Enter then declines). With nothing in focus yet, the first key focuses the
 * first request. Ignored while typing, and with any modifier key (Shift too).
 *
 * Off until the person turns them on with the checkbox this renders (WCAG 2.1.4):
 * single-letter shortcuts that are always live can be set off by speech input or a
 * stray key, and A approves at once. The choice is kept in this browser.
 */
export function ApprovalKeys() {
  const enabled = useSyncExternalStore(subscribe, readEnabled, () => false);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isTyping(e.target)) return;
      const key = e.key.toLowerCase();
      if (!["j", "k", "a", "d"].includes(key)) return;
      const cards = [...document.querySelectorAll<HTMLElement>("[data-approval]")];
      if (cards.length === 0) return;
      const current = cards.findIndex((c) => c.contains(document.activeElement));
      e.preventDefault();
      if (key === "j" || key === "k" || current === -1) {
        const next = current === -1 ? 0 : Math.min(Math.max(current + (key === "k" ? -1 : 1), 0), cards.length - 1);
        cards[next]?.focus();
        return;
      }
      const card = cards[current];
      if (key === "a") card?.querySelector<HTMLButtonElement>("button[value=approve]")?.click();
      else card?.querySelector("form")?.dispatchEvent(new CustomEvent(DECLINE_EVENT));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);

  return (
    <label className="flex min-h-6 items-center gap-2 text-sm text-muted">
      <input type="checkbox" className={nativeCheck} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
      Keyboard shortcuts: J and K move, A approves, D declines with a reason
    </label>
  );
}
