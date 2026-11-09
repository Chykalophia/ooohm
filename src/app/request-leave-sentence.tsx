"use client";

import { NOTE_MAX_LENGTH } from "@/domain/leave-request";
import { REQUEST_FORM_ID } from "@/components/layout/anchors";
import { Section } from "@/components/ui/section";
import { ChipSelect } from "@/components/ui/chip-select";
import { DatePicker } from "@/components/forms/date-picker";
import { cx, fieldClass, focusRing } from "@/components/ui/styles";
import { type LeaveTypeOption, LeavePreviewLine, type Portion, SubmitRow, useLeaveDraft, useRequestAction } from "./request-leave-form";

/**
 * The request as one sentence with the choices inside it: "I'm taking Vacation from
 * Mon, Nov 23 to Wed, Nov 25, full days." It posts the same fields to the same action as
 * the form and shares its live preview, so only the layout differs. An admin picks it
 * under Admin → Appearance.
 */
export function RequestLeaveSentence({
  leaveTypes,
  defaultDate,
  headsUp = false,
}: {
  leaveTypes: LeaveTypeOption[];
  defaultDate: string;
  /** The company turned approval off: the sentence books the time off instead of asking. */
  headsUp?: boolean;
}) {
  const { state, dispatch, pending, onSubmit, key } = useRequestAction();

  return (
    <Section id={REQUEST_FORM_ID} title={headsUp ? "Book time off" : "Request time off"} surface className="scroll-mt-6 space-y-4">
      <form action={dispatch} onSubmit={onSubmit} className="space-y-4">
        <SentenceFields key={key} leaveTypes={leaveTypes} defaultDate={defaultDate} justSubmitted={state.status === "success"} headsUp={headsUp} />
        <SubmitRow state={state} pending={pending} label={headsUp ? "Book it" : "Send request"} />
      </form>
    </Section>
  );
}

/**
 * A choice set inside the sentence: a compact chip, tinted, softly underlined in the
 * accent (firmer on hover and focus), keyboard focusable. Its own tight line height
 * keeps it a chip in the sentence's loose lines instead of a tall box crowding them.
 */
const token = cx(
  "relative mx-0.5 inline-block max-w-full rounded-lg bg-accent/10 px-2 py-0.5 leading-[1.3] text-accent-ink sm:whitespace-nowrap",
  "shadow-[inset_0_-2px_0_color-mix(in_srgb,var(--accent)_40%,transparent)] transition-shadow",
  "hover:shadow-[inset_0_-2px_0_var(--accent)] has-[:focus-visible]:shadow-[inset_0_-2px_0_var(--accent)]",
  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-ink",
  // When the token is the control itself (a date): the same underline while focused or open.
  "focus-visible:shadow-[inset_0_-2px_0_var(--accent)] aria-expanded:shadow-[inset_0_-2px_0_var(--accent)]",
);

const PORTION_WORDS: Record<Portion, string> = {
  full: "all day",
  am: "the morning only",
  pm: "the afternoon only",
};

function SentenceFields({
  leaveTypes,
  defaultDate,
  justSubmitted,
  headsUp,
}: {
  leaveTypes: LeaveTypeOption[];
  defaultDate: string;
  justSubmitted: boolean;
  headsUp: boolean;
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
  } = useLeaveDraft(leaveTypes, defaultDate, justSubmitted);
  const typeName = leaveTypes.find((t) => t.id === leaveTypeId)?.name ?? "";

  return (
    <>
      <p
        className="text-xl leading-[2.05] tracking-[-0.01em] text-balance sm:text-[25px] sm:leading-[1.95]"
        style={{ fontFamily: "var(--display-font)" }}
      >
        I’m taking{" "}
        <ChipSelect
          name="leaveTypeId"
          label="Type of leave"
          value={leaveTypeId}
          onChange={setLeaveTypeId}
          options={leaveTypes.map((t) => ({ value: t.id, label: t.name, color: t.color }))}
          className={token}
        >
          {typeName}
          <Caret />
        </ChipSelect>{" "}
        from <DateToken name="startDate" label="First day" value={startDate} onChange={changeStart} /> to{" "}
        <span className="whitespace-nowrap">
          <DateToken name="endDate" label="Last day" value={endDate} min={startDate} onChange={changeEnd} />,
        </span>{" "}
        <span className="whitespace-nowrap">
          <ChipSelect
            name="dayPortion"
            label="How much of the day"
            value={dayPortion}
            onChange={(v) => setDayPortion(v as Portion)}
            options={[
              { value: "full", label: singleDay ? "all day" : "full days" },
              { value: "am", label: "the morning only", disabled: !singleDay },
              { value: "pm", label: "the afternoon only", disabled: !singleDay },
            ]}
            className={token}
          >
            {singleDay ? PORTION_WORDS[dayPortion] : "full days"}
            <Caret />
          </ChipSelect>
          .
        </span>
      </p>

      <LeavePreviewLine preview={preview} shown={previewShown} className="text-base" />
      {!singleDay && <p className="text-xs text-muted">Half days are for a single date.</p>}

      <details className="group text-sm">
        <summary className={cx("w-fit cursor-pointer rounded-md font-medium text-accent-ink marker:content-none", focusRing)}>
          {headsUp ? "Add a note" : "Add a note for your approver"}
        </summary>
        <textarea
          name="note"
          rows={2}
          maxLength={NOTE_MAX_LENGTH}
          aria-label={headsUp ? "Note" : "Note for your approver"}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className={cx(fieldClass(), "mt-2 resize-y")}
        />
      </details>
    </>
  );
}

/** A date inside the sentence, shown in words ("Mon, Nov 23"), picked from a themed calendar. */
function DateToken(props: { name: string; label: string; value: string; min?: string; onChange: (value: string) => void }) {
  return <DatePicker {...props} className={token} />;
}

function Caret() {
  return (
    <svg aria-hidden viewBox="0 0 12 12" className="ml-1 inline-block h-3 w-3 align-middle opacity-70">
      <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
