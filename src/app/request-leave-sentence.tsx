"use client";

import { useRef } from "react";
import { NOTE_MAX_LENGTH } from "@/domain/leave-request";
import { formatShortDay } from "@/lib/format";
import { type LeaveTypeOption, LeavePreviewLine, type Portion, SubmitRow, useLeaveDraft, useRequestAction } from "./request-leave-form";

/**
 * The request as one sentence with the choices inside it: "I'm taking Vacation from
 * Mon, Nov 23 to Wed, Nov 25, full days." It posts the same fields to the same action as
 * the form and shares its live preview, so only the layout differs. An admin picks it
 * under Admin → Appearance.
 */
export function RequestLeaveSentence({ leaveTypes, defaultDate }: { leaveTypes: LeaveTypeOption[]; defaultDate: string }) {
  const { state, formAction, pending, key } = useRequestAction();

  return (
    <section aria-labelledby="request-heading" className="rounded-2xl border border-border bg-surface p-6">
      <h2 id="request-heading" className="mb-3 text-sm font-medium text-muted">
        Request time off
      </h2>
      <form action={formAction} className="space-y-4">
        <SentenceFields key={key} leaveTypes={leaveTypes} defaultDate={defaultDate} />
        <SubmitRow state={state} pending={pending} label="Send request" />
      </form>
    </section>
  );
}

/** A choice set inside the sentence: tinted, underlined in the accent, keyboard focusable. */
const token =
  "relative inline-flex max-w-full items-center gap-1 rounded-md bg-accent/10 px-1.5 text-accent-ink shadow-[inset_0_-2px_0_var(--accent)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-ink";
/** The native control fills its token and stays invisible, so the sentence reads as text. */
const overlay = "absolute inset-0 h-full w-full cursor-pointer opacity-0";

const PORTION_WORDS: Record<Portion, string> = {
  full: "all day",
  am: "the morning only",
  pm: "the afternoon only",
};

function SentenceFields({ leaveTypes, defaultDate }: { leaveTypes: LeaveTypeOption[]; defaultDate: string }) {
  const { leaveTypeId, setLeaveTypeId, startDate, endDate, dayPortion, setDayPortion, note, setNote, singleDay, preview, changeStart, changeEnd } =
    useLeaveDraft(leaveTypes, defaultDate);
  const typeName = leaveTypes.find((t) => t.id === leaveTypeId)?.name ?? "";

  return (
    <>
      <p
        className="text-xl leading-loose font-medium tracking-tight text-balance sm:text-2xl sm:leading-loose"
        style={{ fontFamily: "var(--display-font)" }}
      >
        I’m taking{" "}
        <span className={token}>
          {typeName}
          <Caret />
          <select
            name="leaveTypeId"
            required
            aria-label="Type of leave"
            value={leaveTypeId}
            onChange={(e) => setLeaveTypeId(e.target.value)}
            className={overlay}
          >
            {leaveTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </span>{" "}
        from <DateToken name="startDate" label="First day" value={startDate} onChange={changeStart} /> to{" "}
        <span className="whitespace-nowrap">
          <DateToken name="endDate" label="Last day" value={endDate} min={startDate} onChange={changeEnd} />,
        </span>{" "}
        <span className="whitespace-nowrap">
          <span className={token}>
            {singleDay ? PORTION_WORDS[dayPortion] : "full days"}
            <Caret />
            <select
              name="dayPortion"
              aria-label="How much of the day"
              value={dayPortion}
              onChange={(e) => setDayPortion(e.target.value as Portion)}
              className={overlay}
            >
              <option value="full">{singleDay ? "all day" : "full days"}</option>
              <option value="am" disabled={!singleDay}>
                the morning only
              </option>
              <option value="pm" disabled={!singleDay}>
                the afternoon only
              </option>
            </select>
          </span>
          .
        </span>
      </p>

      <LeavePreviewLine preview={preview} className="text-base" />
      {!singleDay && <p className="text-xs text-muted">Half days are for a single date.</p>}

      <details className="group text-sm">
        <summary className="w-fit cursor-pointer font-medium text-accent-ink marker:content-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink">
          Add a note for your approver
        </summary>
        <textarea
          name="note"
          rows={2}
          maxLength={NOTE_MAX_LENGTH}
          aria-label="Note for your approver"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="mt-2 w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
      </details>
    </>
  );
}

/**
 * A date inside the sentence, shown in words ("Mon, Nov 23"). The real date input sits
 * over it, invisible: a click or Enter opens the browser's own date picker, and typing
 * still works for keyboard and screen reader users.
 */
function DateToken({
  name,
  label,
  value,
  min,
  onChange,
}: {
  name: string;
  label: string;
  value: string;
  min?: string;
  onChange: (value: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const open = () => {
    try {
      input.current?.showPicker();
    } catch {
      // Older browsers: the focused input still takes typed dates.
    }
  };
  return (
    <span className={`${token} whitespace-nowrap`}>
      {value ? formatShortDay(value) : "pick a date"}
      <input
        ref={input}
        type="date"
        name={name}
        required
        aria-label={label}
        min={min}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            open();
          }
        }}
        className={overlay}
      />
    </span>
  );
}

function Caret() {
  return (
    <svg aria-hidden viewBox="0 0 12 12" className="h-3 w-3 shrink-0 opacity-70">
      <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
