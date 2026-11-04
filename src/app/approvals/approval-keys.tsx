"use client";

import { useEffect } from "react";

/** The event a decision form listens for to start a decline with a reason. */
export const DECLINE_EVENT = "approval:decline";

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Keyboard shortcuts for the Approvals list, for people who decide a lot: J and K move
 * between requests, A approves the one in focus, D starts declining it (focus moves to
 * its reason; Enter then declines). With no request in focus, the first key focuses the
 * nearest one. Ignored while typing, and with any modifier key (Shift too), so they
 * never get in the way. Renders nothing.
 */
export function ApprovalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isTyping(e.target)) return;
      const key = e.key.toLowerCase();
      if (!["j", "k", "a", "d"].includes(key)) return;
      const cards = [...document.querySelectorAll<HTMLElement>("[data-approval]")];
      if (cards.length === 0) return;
      const active = document.activeElement;
      const current = cards.findIndex((c) => c.contains(active));
      e.preventDefault();
      if (current === -1) {
        // Focus is outside every open request (on the page, or on one just decided): go to
        // the nearest open one in the key's direction, else the first.
        const after = (c: HTMLElement) => !!active && (active.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        const target = key === "k" ? cards.findLast((c) => !after(c)) : cards.find(after);
        (target ?? cards[0])?.focus();
        return;
      }
      if (key === "j" || key === "k") {
        cards[Math.min(Math.max(current + (key === "k" ? -1 : 1), 0), cards.length - 1)]?.focus();
        return;
      }
      const card = cards[current];
      if (key === "a") card?.querySelector<HTMLButtonElement>("button[value=approve]")?.click();
      else card?.querySelector("form")?.dispatchEvent(new CustomEvent(DECLINE_EVENT));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
