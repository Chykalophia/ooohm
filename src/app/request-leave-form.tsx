"use client";

import { useActionState, useState } from "react";
import { NOTE_MAX_LENGTH } from "@/domain/leave-request";
import { requestLeaveAction } from "./actions";
import { type FormState, IDLE, nextFormKey } from "./form-state";

type LeaveTypeOption = { id: string; name: string; color: string };
type Portion = "full" | "am" | "pm";

const PORTIONS: { value: Portion; label: string }[] = [
  { value: "full", label: "Full day" },
  { value: "am", label: "Morning" },
  { value: "pm", label: "Afternoon" },
];

const field =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 outline-none focus:border-accent focus:ring-2 focus:ring-accent/20";

/**
 * The dashboard's one main action. Everything is pre-filled (first leave type, the next working day,
 * full day), so asking for a single day off is pick a date, then submit.
 */
export function RequestLeaveForm({ leaveTypes, defaultDate }: { leaveTypes: LeaveTypeOption[]; defaultDate: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(requestLeaveAction, IDLE);
  // A successful submit remounts the fields, which resets them to their defaults; an
  // error keeps the current key so the person's input survives.
  const [resetKey, setResetKey] = useState("form");
  const key = nextFormKey(resetKey, state);
  if (key !== resetKey) setResetKey(key);

  return (
    <section aria-labelledby="request-heading" className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
      <h2 id="request-heading" className="mb-5 text-lg font-semibold tracking-tight">
        Request time off
      </h2>
      <form action={formAction} className="space-y-5">
        <Fields key={key} leaveTypes={leaveTypes} defaultDate={defaultDate} />
        <div className="flex flex-wrap items-center gap-4">
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-accent px-4 py-2 font-medium text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
          >
            {pending ? "Sending…" : "Request time off"}
          </button>
          <p aria-live="polite" className="text-sm">
            {state.status === "success" && <span className="text-accent">{state.message}</span>}
            {state.status === "error" && (
              <span role="alert" className="text-red-700 dark:text-red-400">
                {state.message}
              </span>
            )}
          </p>
        </div>
      </form>
    </section>
  );
}

function Fields({ leaveTypes, defaultDate }: { leaveTypes: LeaveTypeOption[]; defaultDate: string }) {
  const [leaveTypeId, setLeaveTypeId] = useState(leaveTypes[0]?.id ?? "");
  const [startDate, setStartDate] = useState(defaultDate);
  const [endDate, setEndDate] = useState(defaultDate);
  const [dayPortion, setDayPortion] = useState<Portion>("full");
  const [note, setNote] = useState("");
  const singleDay = startDate === endDate;

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
    </>
  );
}
