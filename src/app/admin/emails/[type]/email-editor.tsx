"use client";

import { useEffect, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import { ActionForm } from "@/components/forms/action-form";
import { ErrorMessage } from "@/components/forms/form-status";
import { TextAreaField, TextField } from "@/components/ui/fields";
import { unknownVariables } from "@/domain/email-template";
import { cx, focusRing, outlineButton } from "@/components/ui/styles";
import { type PreviewState, previewEmailAction, saveEmailCopyAction } from "@/app/admin/emails/actions";

type Field = "subject" | "message";

/** How long typing pauses before the preview catches up. */
const PREVIEW_DELAY_MS = 400;

/**
 * The editor for one email: its subject and message, the variables they may use (a
 * click puts one where the cursor was), and a live preview of the email as it would go
 * out, with made-up data. Saving is the one main action.
 */
export function EmailEditor({
  type,
  initial,
  variables,
  firstPreview,
}: {
  type: string;
  initial: { subject: string; message: string };
  variables: readonly { name: string; description: string }[];
  firstPreview: { subject: string; html: string };
}) {
  const [copy, setCopy] = useState(initial);
  // After a save or reset the page sends the words now in force; show those.
  const [shownInitial, setShownInitial] = useState(initial);
  if (shownInitial.subject !== initial.subject || shownInitial.message !== initial.message) {
    setShownInitial(initial);
    setCopy(initial);
  }
  // The last preview that rendered, kept on screen while the draft has a mistake in it.
  const [shown, setShown] = useState(firstPreview);
  const [problem, setProblem] = useState<string | null>(null);
  // Where a variable goes: the field and selection the cursor was last in.
  const [cursor, setCursor] = useState<{ field: Field; start: number; end: number }>({
    field: "message",
    start: initial.message.length,
    end: initial.message.length,
  });
  const first = useRef(true);

  // A variable the email doesn't have is named here at once, without asking the server.
  const names = variables.map((v) => v.name);
  const unknown = [...new Set([...unknownVariables(copy.subject, names), ...unknownVariables(copy.message, names)])];
  const mistake =
    unknown.length > 0
      ? `This email has no ${unknown.map((n) => `{{${n}}}`).join(" or ")}. Use one of the variables listed.`
      : problem;

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    let live = true;
    const timer = setTimeout(async () => {
      const next: PreviewState = await previewEmailAction({ type, ...copy });
      if (!live) return;
      if (next.status === "preview") {
        setShown({ subject: next.subject, html: next.html });
        setProblem(null);
      } else setProblem(next.message);
    }, PREVIEW_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [type, copy]);

  function track(field: Field) {
    return (e: SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const el = e.currentTarget;
      setCursor({ field, start: el.selectionStart ?? el.value.length, end: el.selectionEnd ?? el.value.length });
    };
  }

  function insert(name: string) {
    const { field, start, end } = cursor;
    const token = `{{${name}}}`;
    const value = copy[field];
    const at = Math.min(start, value.length);
    setCopy({ ...copy, [field]: value.slice(0, at) + token + value.slice(Math.min(end, value.length)) });
    const caret = at + token.length;
    setCursor({ field, start: caret, end: caret });
    requestAnimationFrame(() => {
      const el = document.getElementsByName(field)[0] as HTMLInputElement | HTMLTextAreaElement | undefined;
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <ActionForm action={saveEmailCopyAction} submitLabel="Save wording" pendingLabel="Saving…">
        <input type="hidden" name="type" value={type} />
        <TextField
          label="Subject"
          name="subject"
          value={copy.subject}
          onChange={(e) => setCopy({ ...copy, subject: e.target.value })}
          onSelect={track("subject")}
          hint="One line. Leave it empty for OOOhm's own subject."
        />
        <TextAreaField
          label="Message"
          name="message"
          rows={6}
          value={copy.message}
          onChange={(e) => setCopy({ ...copy, message: e.target.value })}
          onSelect={track("message")}
          hint="The first paragraph leads the email. Leave a blank line to start another; those come after the request's details. Leave it empty for OOOhm's own message."
        />
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Variables</legend>
          <p className="text-xs text-muted">Each fills in for the email it goes in. Choose one to add it where the cursor was.</p>
          <ul className="space-y-2">
            {variables.map((v) => (
              <li key={v.name} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <button
                  type="button"
                  onClick={() => insert(v.name)}
                  className={cx(outlineButton, "font-mono")}
                  aria-label={`Add {{${v.name}}}: ${v.description}`}
                >
                  {`{{${v.name}}}`}
                </button>
                <span className="text-xs text-muted">{v.description}</span>
              </li>
            ))}
          </ul>
        </fieldset>
      </ActionForm>

      <section aria-label="Preview" className="space-y-2">
        <h2 className="text-sm font-medium">Preview</h2>
        <p className="text-xs text-muted">With made-up names and dates, in your accent colour.</p>
        {mistake && <ErrorMessage as="p">{mistake}</ErrorMessage>}
        <p className="text-sm">
          <span className="text-muted">Subject:</span> {shown.subject}
        </p>
        <iframe
          title="Email preview"
          sandbox=""
          srcDoc={shown.html}
          className={cx("h-[34rem] w-full rounded-xl border border-border", focusRing)}
        />
      </section>
    </div>
  );
}
