"use client";

import { useEffect, useState } from "react";
import { NOTE_MAX_LENGTH } from "@/domain/leave-request";
import { IDLE, nextFormKey } from "@/components/forms/form-state";
import { FormStatus } from "@/components/forms/form-status";
import { useFormAction } from "@/components/forms/use-form-action";
import { REQUEST_FORM_ID } from "@/components/layout/anchors";
import { ChoiceChip, Fieldset, SelectField, TextAreaField, TextField } from "@/components/ui/fields";
import { Section } from "@/components/ui/section";
import { cx, errorText, primaryButton } from "@/components/ui/styles";
import type { LeavePreviewResponse } from "./_lib/leave-input";
import { requestLeaveAction } from "./actions";
import { showsPreview } from "./request-preview";

type LeaveTypeOption = { id: string; name: string; color: string };
type Portion = "full" | "am" | "pm";

const PORTIONS: { value: Portion; label: string }[] = [
  { value: "full", label: "Full day" },
  { value: "am", label: "Morning" },
  { value: "pm", label: "Afternoon" },
];

/** How long the form waits after the last change before asking for a preview. */
const PREVIEW_DELAY_MS = 300;
const PREVIEW_ID = "leave-preview";

/**
 * The dashboard's one main action. Everything is pre-filled (first leave type, the next working day,
 * full day), so asking for a single day off is pick a date, then submit.
 */
export function RequestLeaveForm({ leaveTypes, defaultDate }: { leaveTypes: LeaveTypeOption[]; defaultDate: string }) {
  const { state, dispatch, pending, onSubmit } = useFormAction(requestLeaveAction, IDLE);
  // A successful submit remounts the fields, which resets them to their defaults; an
  // error keeps the current key so the person's input survives.
  const [resetKey, setResetKey] = useState("form");
  const key = nextFormKey(resetKey, state);
  if (key !== resetKey) setResetKey(key);

  return (
    <Section id={REQUEST_FORM_ID} title="Request time off" surface className="scroll-mt-6 space-y-5 shadow-sm">
      <form action={dispatch} onSubmit={onSubmit} className="space-y-5">
        <Fields key={key} leaveTypes={leaveTypes} defaultDate={defaultDate} justSubmitted={state.status === "success"} />
        <div className="flex flex-wrap items-center gap-4">
          <button type="submit" aria-disabled={pending} aria-describedby={PREVIEW_ID} className={primaryButton}>
            {pending ? "Sending…" : "Request time off"}
          </button>
          <FormStatus state={state} />
        </div>
      </form>
    </Section>
  );
}

function Fields({
  leaveTypes,
  defaultDate,
  justSubmitted,
}: {
  leaveTypes: LeaveTypeOption[];
  defaultDate: string;
  justSubmitted: boolean;
}) {
  const [leaveTypeId, setLeaveTypeId] = useState(leaveTypes[0]?.id ?? "");
  const [startDate, setStartDate] = useState(defaultDate);
  const [endDate, setEndDate] = useState(defaultDate);
  const [dayPortion, setDayPortion] = useState<Portion>("full");
  const [note, setNote] = useState("");
  const singleDay = startDate === endDate;
  const draft = { leaveTypeId, startDate, endDate, dayPortion };
  const preview = useLeavePreview(draft);
  const defaults = { leaveTypeId: leaveTypes[0]?.id ?? "", startDate: defaultDate, endDate: defaultDate, dayPortion: "full" };
  const previewShown = showsPreview(justSubmitted, draft, defaults);

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

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          label="Type"
          name="leaveTypeId"
          required
          value={leaveTypeId}
          onChange={(e) => setLeaveTypeId(e.target.value)}
          options={leaveTypes.map((t) => ({ value: t.id, label: t.name }))}
        />
        <TextField label="From" type="date" name="startDate" required value={startDate} onChange={(e) => changeStart(e.target.value)} />
        <TextField label="To" type="date" name="endDate" required min={startDate} value={endDate} onChange={(e) => changeEnd(e.target.value)} />
      </div>

      <Fieldset legend="How much of the day" hint={singleDay ? undefined : "Half days are for a single date."} className="space-y-1.5">
        <div className="flex flex-wrap gap-2">
          {PORTIONS.map((p) => (
            <ChoiceChip
              key={p.value}
              type="radio"
              name="dayPortion"
              value={p.value}
              checked={dayPortion === p.value}
              disabled={p.value !== "full" && !singleDay}
              onChange={() => setDayPortion(p.value)}
            >
              {p.label}
            </ChoiceChip>
          ))}
        </div>
      </Fieldset>

      <TextAreaField label="Note" optional name="note" rows={2} maxLength={NOTE_MAX_LENGTH} value={note} onChange={(e) => setNote(e.target.value)} />

      {/* Staleness is shown with the muted colour token, never opacity, which would take
          the red error line below AA contrast. aria-busy tells screen readers. */}
      <p
        id={PREVIEW_ID}
        aria-live="polite"
        aria-busy={!preview.current}
        className={cx("min-h-5 text-sm", !preview.ok ? errorText : preview.current ? "text-foreground" : "text-muted")}
      >
        {previewShown && preview.message}
      </p>
    </>
  );
}

type Draft = { leaveTypeId: string; startDate: string; endDate: string; dayPortion: Portion };
type Preview = { query: string; ok: boolean; message: string };

/**
 * Asks the server what the draft would cost and leave ("This request takes 3 days.
 * Afterwards you'd have 12 days left for 2026."), or why it can't be requested, using the same computation as
 * submit. Debounced; a newer draft aborts the older request, so answers never arrive
 * out of order. While a newer answer is on its way, the last one stays, marked busy.
 */
function useLeavePreview(draft: Draft): { message: string; ok: boolean; current: boolean } {
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
