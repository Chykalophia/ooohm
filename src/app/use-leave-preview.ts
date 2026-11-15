"use client";

import { useEffect, useState } from "react";
import type { LeavePreviewResponse } from "./_lib/leave-input";

/** How long the hook waits after the last change before asking for a preview. */
export const PREVIEW_DELAY_MS = 300;

/** The fields of a draft request the preview reads. */
export type PreviewDraft = { leaveTypeId: string; startDate: string; endDate: string; dayPortion: string };

/** A preview's sentence, whether the draft can be sent, and whether it matches the draft as it is now. */
export type LeavePreview = { message: string; ok: boolean; current: boolean };

type Answer = { query: string; ok: boolean; message: string };

/**
 * Asks the server what the draft would cost and leave ("This request takes 3 days.
 * Afterwards you'd have 12 days left for 2026."), or why it can't be requested, using the
 * same computation as submit. Debounced; a newer draft aborts the older request, so
 * answers never arrive out of order. While a newer answer is on its way, the last one
 * stays, marked not current. The app's only client-side data fetch (ADR-0008).
 *
 * @param forUserId Someone else the time off is for (`for=`): what it would cost them.
 */
export function useLeavePreview(draft: PreviewDraft, forUserId?: string): LeavePreview {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const complete = draft.leaveTypeId !== "" && draft.startDate !== "";
  const query = new URLSearchParams(forUserId ? { ...draft, for: forUserId } : draft).toString();

  useEffect(() => {
    if (!complete) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/leave-preview?${query}`, { signal: controller.signal, cache: "no-store" });
        const body = (await res.json()) as LeavePreviewResponse;
        setAnswer({ query, ok: body.ok, message: body.message });
      } catch {
        if (!controller.signal.aborted) setAnswer({ query, ok: false, message: "The preview isn't available right now." });
      }
    }, PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [complete, query]);

  if (!complete || !answer) return { message: "", ok: true, current: true };
  return { message: answer.message, ok: answer.ok, current: answer.query === query };
}
