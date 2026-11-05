"use client";

import { useEffect, useState } from "react";
import { PendingLabel } from "@/components/ui/ooo-dots";
import { NOTE_MAX_LENGTH } from "@/domain/leave-request";
import { type FormState, IDLE, nextFormKey } from "@/components/forms/form-state";
import { FormStatus } from "@/components/forms/form-status";
import { useFormAction } from "@/components/forms/use-form-action";
import { ADD_LEAVE_FORM_ID, REQUEST_FORM_ID } from "@/components/layout/anchors";
import { ChoiceChip, Fieldset, SelectField, TextAreaField, TextField } from "@/components/ui/fields";
import { Section } from "@/components/ui/section";
import { cx, errorText, primaryButton } from "@/components/ui/styles";
import type { LeavePreviewResponse } from "./_lib/leave-input";
import { addLeaveForAction, requestLeaveAction } from "./actions";
import { showsPreview } from "./request-preview";

export type LeaveTypeOption = { id: string; name: string; color: string };
export type Portion = "full" | "am" | "pm";

/** Someone else the form adds time off for (a teammate's page, for an admin or their manager). */
export type ForPerson = { id: string; name: string };

const PORTIONS: { value: Portion; label: string }[] = [
  { value: "full", label: "Full day" },
  { value: "am", label: "Morning" },
  { value: "pm", label: "Afternoon" },
];

/** How long the form waits after the last change before asking for a preview. */
const PREVIEW_DELAY_MS = 300;
const PREVIEW_ID = "leave-preview";

/**
 * The dashboard's one main action, as labelled fields. Everything is pre-filled (first
 * leave type, the next working day, full day), so asking for a single day off is pick a
 * date, then submit. An admin can swap it for {@link RequestLeaveSentence}, which shares
 * every piece below.
 *
 * With `forPerson` it adds time off for that person instead, approved as it is added
 * (`addLeaveForAction`), and its preview talks about them.
 */
export function RequestLeaveForm({
  leaveTypes,
  defaultDate,
  forPerson,
}: {
  leaveTypes: LeaveTypeOption[];
  defaultDate: string;
  forPerson?: ForPerson;
}) {
  const { state, dispatch, pending, onSubmit, key } = useRequestAction(forPerson ? addLeaveForAction : requestLeaveAction);
  const label = forPerson ? "Add time off" : "Request time off";

  return (
    <Section
      id={forPerson ? ADD_LEAVE_FORM_ID : REQUEST_FORM_ID}
      title={forPerson ? `Add time off for ${forPerson.name}` : "Request time off"}
      surface
      className="scroll-mt-6 space-y-5"
    >
      <form action={dispatch} onSubmit={onSubmit} className="space-y-5">
        {forPerson && (
          <>
            <input type="hidden" name="userId" value={forPerson.id} />
            <p className="text-sm text-muted">It&apos;s approved as you add it, and they get an email about it.</p>
          </>
        )}
        <Fields
          key={key}
          leaveTypes={leaveTypes}
          defaultDate={defaultDate}
          justSubmitted={state.status === "success"}
          forUserId={forPerson?.id}
        />
        <SubmitRow state={state} pending={pending} label={label} />
      </form>
    </Section>
  );
}

/**
 * The submit action plus a key for the fields: a successful submit remounts them, which
 * resets them to their defaults; an error keeps the current key so the person's input
 * survives. Shared by the form and the sentence.
 */
export function useRequestAction(action: typeof requestLeaveAction = requestLeaveAction) {
  const { state, dispatch, pending, onSubmit } = useFormAction(action, IDLE);
  const [resetKey, setResetKey] = useState("form");
  const key = nextFormKey(resetKey, state);
  if (key !== resetKey) setResetKey(key);
  return { state, dispatch, pending, onSubmit, key };
}

/** The submit button and the outcome of the last submit. */
export function SubmitRow({ state, pending, label }: { state: FormState; pending: boolean; label: string }) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <button type="submit" aria-disabled={pending} aria-describedby={PREVIEW_ID} className={primaryButton}>
        {pending ? <PendingLabel label="Sending…" /> : label}
      </button>
      <FormStatus state={state} />
    </div>
  );
}

/**
 * A draft request's state and the rules that tie its fields together, plus its live
 * preview and whether to show it. Shared by the form and the sentence, so both behave
 * the same.
 *
 * @param justSubmitted The last submit succeeded: the preview stays hidden until the
 *   person starts the next request.
 * @param forUserId Someone else the time off is for: the preview is for them.
 */
export function useLeaveDraft(leaveTypes: LeaveTypeOption[], defaultDate: string, justSubmitted: boolean, forUserId?: string) {
  const [leaveTypeId, setLeaveTypeId] = useState(leaveTypes[0]?.id ?? "");
  const [startDate, setStartDate] = useState(defaultDate);
  const [endDate, setEndDate] = useState(defaultDate);
  const [dayPortion, setDayPortion] = useState<Portion>("full");
  const [note, setNote] = useState("");
  const singleDay = startDate === endDate;
  const draft = { leaveTypeId, startDate, endDate, dayPortion };
  const preview = useLeavePreview(draft, forUserId);
  const defaults = { leaveTypeId: leaveTypes[0]?.id ?? "", startDate: defaultDate, endDate: defaultDate, dayPortion: "full" };
  // The note is not previewed, but typing one is starting the next request, so it counts here.
  const previewShown = showsPreview(justSubmitted, { ...draft, note }, { ...defaults, note: "" });

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
    previewShown,
    changeStart,
    changeEnd,
  };
}

function Fields({
  leaveTypes,
  defaultDate,
  justSubmitted,
  forUserId,
}: {
  leaveTypes: LeaveTypeOption[];
  defaultDate: string;
  justSubmitted: boolean;
  forUserId?: string;
}) {
  const {
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
    previewShown,
    changeStart,
    changeEnd,
  } = useLeaveDraft(leaveTypes, defaultDate, justSubmitted, forUserId);

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
        <TextField
          label="To"
          type="date"
          name="endDate"
          required
          min={startDate}
          value={endDate}
          onChange={(e) => changeEnd(e.target.value)}
        />
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

      <TextAreaField
        label="Note"
        optional
        name="note"
        rows={2}
        maxLength={NOTE_MAX_LENGTH}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      <LeavePreviewLine preview={preview} shown={previewShown} />
    </>
  );
}

/**
 * What the draft would cost and leave, or why it can't be requested. Staleness is shown
 * with the muted colour token, never opacity, which would take the red error line below
 * AA contrast. aria-busy tells screen readers.
 */
export function LeavePreviewLine({ preview, shown, className = "text-sm" }: { preview: LeavePreview; shown: boolean; className?: string }) {
  return (
    <p
      id={PREVIEW_ID}
      aria-live="polite"
      aria-busy={shown && !preview.current}
      className={cx("min-h-5", className, !preview.ok ? errorText : preview.current ? "text-foreground" : "text-muted")}
    >
      {shown && preview.message}
    </p>
  );
}

type Draft = { leaveTypeId: string; startDate: string; endDate: string; dayPortion: Portion };
type Preview = { query: string; ok: boolean; message: string };

/** A preview's sentence, whether the draft can be sent, and whether it matches the draft as it is now. */
export type LeavePreview = { message: string; ok: boolean; current: boolean };

/**
 * Asks the server what the draft would cost and leave ("This request takes 3 days.
 * Afterwards you'd have 12 days left for 2026."), or why it can't be requested, using the same computation as
 * submit. Debounced; a newer draft aborts the older request, so answers never arrive
 * out of order. While a newer answer is on its way, the last one stays, marked busy.
 *
 * @param forUserId Someone else the time off is for (`for=`): what it would cost them.
 */
export function useLeavePreview(draft: Draft, forUserId?: string): LeavePreview {
  const [preview, setPreview] = useState<Preview | null>(null);
  const complete = draft.leaveTypeId !== "" && draft.startDate !== "";
  const query = new URLSearchParams(forUserId ? { ...draft, for: forUserId } : draft).toString();

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
