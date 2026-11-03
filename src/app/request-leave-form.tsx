"use client";

import { useActionState, useEffect, useState } from "react";
import { NOTE_MAX_LENGTH } from "@/domain/leave-request";
import { requestLeaveAction } from "./actions";
import { type FormState, IDLE, nextFormKey } from "./form-state";
import type { LeavePreviewResponse } from "./leave-input";

export type LeaveTypeOption = { id: string; name: string; color: string };
export type Portion = "full" | "am" | "pm";

const PORTIONS: { value: Portion; label: string }[] = [
  { value: "full", label: "Full day" },
  { value: "am", label: "Morning" },
  { value: "pm", label: "Afternoon" },
];

/** How long the form waits after the last change before asking for a preview. */
const PREVIEW_DELAY_MS = 300;
export const PREVIEW_ID = "leave-preview";

const field =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 outline-none focus:border-accent focus:ring-2 focus:ring-accent/20";

/**
 * The dashboard's one main action. Everything is pre-filled (first leave type, the next working day,
 * full day), so asking for a single day off is pick a date, then submit.
 */
export function RequestLeaveForm({ leaveTypes, defaultDate }: { leaveTypes: LeaveTypeOption[]; defaultDate: string }) {
  const { state, formAction, pending, key } = useRequestAction();

  return (
    <section aria-labelledby="request-heading" className="rounded-2xl border border-border bg-surface p-6">
      <h2 id="request-heading" className="mb-5 text-lg font-semibold tracking-tight">
        Request time off
      </h2>
      <form action={formAction} className="space-y-5">
        <Fields key={key} leaveTypes={leaveTypes} defaultDate={defaultDate} />
        <SubmitRow state={state} pending={pending} label="Request time off" />
      </form>
    </section>
  );
}

/** The submit button and the outcome of the last submit. */
export function SubmitRow({ state, pending, label }: { state: FormState; pending: boolean; label: string }) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <button
        type="submit"
        disabled={pending}
        aria-describedby={PREVIEW_ID}
        className="rounded-lg bg-accent px-4 py-2 font-medium text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink disabled:opacity-60"
      >
        {pending ? "Sending…" : label}
      </button>
      <p aria-live="polite" className="text-sm">
        {state.status === "success" && <span className="text-accent-ink">{state.message}</span>}
        {state.status === "error" && (
          <span role="alert" className="text-red-700 dark:text-red-400">
            {state.message}
          </span>
        )}
      </p>
    </div>
  );
}

/**
 * The submit action plus a key for the fields: a successful submit remounts them, which
 * resets them to their defaults; an error keeps the current key so the person's input
 * survives. Shared by the form and the sentence.
 */
export function useRequestAction() {
  const [state, formAction, pending] = useActionState<FormState, FormData>(requestLeaveAction, IDLE);
  const [resetKey, setResetKey] = useState("form");
  const key = nextFormKey(resetKey, state);
  if (key !== resetKey) setResetKey(key);
  return { state, formAction, pending, key };
}

/**
 * A draft request's state and the rules that tie its fields together, plus its live
 * preview. Shared by the form and the sentence, so both behave the same.
 */
export function useLeaveDraft(leaveTypes: LeaveTypeOption[], defaultDate: string) {
  const [leaveTypeId, setLeaveTypeId] = useState(leaveTypes[0]?.id ?? "");
  const [startDate, setStartDate] = useState(defaultDate);
  const [endDate, setEndDate] = useState(defaultDate);
  const [dayPortion, setDayPortion] = useState<Portion>("full");
  const [note, setNote] = useState("");
  const singleDay = startDate === endDate;
  const preview = useLeavePreview({ leaveTypeId, startDate, endDate, dayPortion });

  function changeStart(value: string) {
    // The end date follows the start until someone picks a later end on purpose.
    const nextEnd = endDate === startDate || endDate < value ? value : endDate;
    setStartDate(value);
    setEndDate(nextEnd);
    if (nextEnd !== value) setDayPortion("full");
  }

  function changeEnd(value: string) {
    setEndDate(value);
    if (value !== startDate) setDayPortion("full");
  }

  return {
    leaveTypeId,
    setLeaveTypeId,
    startDate,
    endDate,
    dayPortion,
    setDayPortion,
    note,
    setNote,
    singleDay,
    preview,
    changeStart,
    changeEnd,
  };
}

function Fields({ leaveTypes, defaultDate }: { leaveTypes: LeaveTypeOption[]; defaultDate: string }) {
  const { leaveTypeId, setLeaveTypeId, startDate, endDate, dayPortion, setDayPortion, note, setNote, singleDay, preview, changeStart, changeEnd } =
    useLeaveDraft(leaveTypes, defaultDate);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Type</span>
          <select name="leaveTypeId" required value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)} className={field}>
            {leaveTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">From</span>
          <input type="date" name="startDate" required value={startDate} onChange={(e) => changeStart(e.target.value)} className={field} />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">To</span>
          <input
            type="date"
            name="endDate"
            required
            min={startDate}
            value={endDate}
            onChange={(e) => changeEnd(e.target.value)}
            className={field}
          />
        </label>
      </div>

      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">How much of the day</legend>
        <div className="flex flex-wrap gap-2">
          {PORTIONS.map((p) => {
            const disabled = p.value !== "full" && !singleDay;
            return (
              <label
                key={p.value}
                className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/40 ${
                  dayPortion === p.value ? "border-accent text-foreground" : "border-border text-muted"
                } ${disabled ? "opacity-50" : "cursor-pointer"}`}
              >
                <input
                  type="radio"
                  name="dayPortion"
                  value={p.value}
                  checked={dayPortion === p.value}
                  disabled={disabled}
                  onChange={() => setDayPortion(p.value)}
                  className="accent-[var(--accent)]"
                />
                {p.label}
              </label>
            );
          })}
        </div>
        {!singleDay && <p className="text-xs text-muted">Half days are for a single date.</p>}
      </fieldset>

      <label className="block space-y-1.5">
        <span className="text-sm font-medium">
          Note <span className="font-normal text-muted">(optional)</span>
        </span>
        <textarea
          name="note"
          rows={2}
          maxLength={NOTE_MAX_LENGTH}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className={`${field} resize-y`}
        />
      </label>

      <LeavePreviewLine preview={preview} />
    </>
  );
}

/**
 * What the draft would cost and leave, or why it can't be requested. Staleness is shown
 * with the muted colour token, never opacity, which would take the red error line below
 * AA contrast. aria-busy tells screen readers.
 */
export function LeavePreviewLine({ preview, className = "text-sm" }: { preview: LeavePreview; className?: string }) {
  return (
    <p
      id={PREVIEW_ID}
      aria-live="polite"
      aria-busy={!preview.current}
      className={`min-h-5 ${className} ${!preview.ok ? "text-red-700 dark:text-red-400" : preview.current ? "text-foreground" : "text-muted"}`}
    >
      {preview.message}
    </p>
  );
}

type Draft = { leaveTypeId: string; startDate: string; endDate: string; dayPortion: Portion };
type Preview = { query: string; ok: boolean; message: string };

/**
 * Asks the server what the draft would cost and leave ("This is 3 days. You'll have 12
 * days left for 2026."), or why it can't be requested, using the same computation as
 * submit. Debounced; a newer draft aborts the older request, so answers never arrive
 * out of order. While a newer answer is on its way, the last one stays, marked busy.
 */
export type LeavePreview = { message: string; ok: boolean; current: boolean };

function useLeavePreview(draft: Draft): LeavePreview {
  const [preview, setPreview] = useState<Preview | null>(null);
  const complete = draft.leaveTypeId !== "" && draft.startDate !== "";
  const query = new URLSearchParams(draft).toString();

  useEffect(() => {
    if (!complete) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/leave-preview?${query}`, { signal: controller.signal, cache: "no-store" });
        const body = (await res.json()) as LeavePreviewResponse;
        setPreview({ query, ok: body.ok, message: body.message });
      } catch {
        if (!controller.signal.aborted) setPreview({ query, ok: false, message: "The preview isn't available right now." });
      }
    }, PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [complete, query]);

  if (!complete || !preview) return { message: "", ok: true, current: true };
  return { message: preview.message, ok: preview.ok, current: preview.query === query };
}
