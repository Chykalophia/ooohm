"use client";

import { cx, subtleButton } from "@/components/ui/styles";

/**
 * "Keep it": backs out of an "ask first" question ({@link useConfirm}'s `back`). Once
 * "Yes" is sent there is nothing left to back out of, so while the action runs it is
 * `aria-disabled` and does nothing: closing the question then would tell the person they
 * backed out while the change still lands. `aria-disabled` rather than `disabled`, so a
 * focused button keeps focus.
 */
export function KeepIt({ pending, onBack, className }: { pending: boolean; onBack: () => void; className?: string }) {
  return (
    <button type="button" aria-disabled={pending} onClick={() => !pending && onBack()} className={cx(className ?? subtleButton)}>
      Keep it
    </button>
  );
}
