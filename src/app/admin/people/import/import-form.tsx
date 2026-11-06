"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { FormStatus } from "@/components/forms/form-status";
import { useFormAction } from "@/components/forms/use-form-action";
import { Item, ItemList } from "@/components/ui/card";
import { CheckboxField } from "@/components/ui/fields";
import { PendingLabel } from "@/components/ui/ooo-dots";
import { cx, field, primaryButton, subtleButton, textLink } from "@/components/ui/styles";
import { IMPORT_IDLE, type ImportPreviewRow, type ImportState } from "./import-state";
import type { peopleImportAction } from "./actions";

type Action = typeof peopleImportAction;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function RowList({ rows, label }: { rows: ImportPreviewRow[]; label: string }) {
  return (
    <ItemList aria-label={label}>
      {rows.map((r) => (
        <Item key={r.line} className="space-y-0.5 text-sm">
          <p className="break-words">
            <span className="text-muted">Line {r.line} · </span>
            <span className="font-medium">{r.name || r.email || "No email"}</span>
            {r.name && <span className="break-all text-muted"> · {r.email}</span>}
          </p>
          <p className={r.status === "error" ? "text-danger" : "text-muted"}>{r.details}</p>
        </Item>
      ))}
    </ItemList>
  );
}

/** The checked file: what importing it would do, and the one button that does it. */
function Preview({ state, pending, onSubmit, dispatch, onStartOver }: {
  state: Extract<ImportState, { status: "preview" }>;
  pending: boolean;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  dispatch: (data: FormData) => void;
  onStartOver: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [state.id]);

  const errors = state.rows.filter((r) => r.status === "error");
  const skips = state.rows.filter((r) => r.status === "skip");
  const adds = state.rows.filter((r) => r.status === "add");
  const ready = state.errors === 0 && state.adds > 0;

  const summary =
    state.errors > 0
      ? `${plural(state.errors, "row needs", "rows need")} fixing before anyone can be added.`
      : state.adds === 0
        ? "Everyone in this file already has an account, so there's nobody to add."
        : `Ready to add ${plural(state.adds, "person", "people")}.`;

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">
          {summary}
        </h2>
        <p className="text-sm text-muted">
          {[
            state.fileName,
            state.skips > 0 && `${plural(state.skips, "person", "people")} already here will be left as is`,
            state.newDepartments.length > 0 && `New ${state.newDepartments.length === 1 ? "department" : "departments"}: ${state.newDepartments.join(", ")}`,
            state.ignoredColumns.length > 0 && `Ignored ${state.ignoredColumns.length === 1 ? "column" : "columns"}: ${state.ignoredColumns.join(", ")}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      {state.problem && (
        <p role="alert" className="text-sm text-danger">
          {state.problem}
        </p>
      )}

      {errors.length > 0 && <RowList rows={errors} label="Rows to fix" />}

      {ready && (
        <form action={dispatch} onSubmit={onSubmit} className="space-y-4">
          <input type="hidden" name="intent" value="import" />
          <input type="hidden" name="csv" value={state.csv} />
          <input type="hidden" name="fileName" value={state.fileName} />
          <CheckboxField
            name="sendInvites"
            label="Email each person their invite now"
            hint="Leave it off to add everyone quietly. They can still sign in from the sign-in page, and you can send an invite later from their page."
            defaultChecked
          />
          <div className="flex flex-wrap items-center gap-4">
            <button type="submit" aria-disabled={pending} className={primaryButton}>
              {pending ? <PendingLabel label="Adding…" /> : `Add ${plural(state.adds, "person", "people")}`}
            </button>
            <button type="button" aria-disabled={pending} onClick={pending ? undefined : onStartOver} className={subtleButton}>
              Choose another file
            </button>
          </div>
        </form>
      )}

      {adds.length > 0 && (
        <details className="space-y-3">
          <summary className={cx(subtleButton, "cursor-pointer")}>Who will be added ({adds.length})</summary>
          <RowList rows={adds} label="People to add" />
        </details>
      )}
      {skips.length > 0 && (
        <details className="space-y-3">
          <summary className={cx(subtleButton, "cursor-pointer")}>Already here ({skips.length})</summary>
          <RowList rows={skips} label="People already here" />
        </details>
      )}
    </div>
  );
}

function Importer({ action, onStartOver }: { action: Action; onStartOver: () => void }) {
  const { state, dispatch, pending, onSubmit } = useFormAction<ImportState>(action, IMPORT_IDLE);
  const done = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state.status === "imported") done.current?.focus();
  }, [state]);

  const preview = state.status === "preview" ? state : null;
  const showUpload = !preview || preview.errors > 0 || preview.adds === 0;

  return (
    <div className="space-y-6">
      {state.status === "imported" && (
        <div className="space-y-2 rounded-xl border border-accent/40 bg-accent/5 p-4">
          <p ref={done} tabIndex={-1} className="text-sm font-medium outline-none">
            {state.message}
          </p>
          <Link href="/admin/people" className={cx(textLink, "text-sm font-medium text-accent-ink")}>
            See everyone in People
          </Link>
        </div>
      )}

      {preview && <Preview state={preview} pending={pending} onSubmit={onSubmit} dispatch={dispatch} onStartOver={onStartOver} />}

      {showUpload && (
        <form key={state.status === "imported" ? state.id : "upload"} action={dispatch} onSubmit={onSubmit} className="space-y-4">
          <input type="hidden" name="intent" value="check" />
          <div className="space-y-1.5">
            <label htmlFor="people-import-file" className="block text-sm font-medium">
              {preview?.errors ? "Upload the fixed file" : preview ? "Upload another file" : state.status === "imported" ? "Import another file" : "CSV file"}
            </label>
            <input
              id="people-import-file"
              name="file"
              type="file"
              accept=".csv,text/csv"
              required
              aria-describedby="people-import-file-hint"
              className={cx(field, "file:mr-3 file:border-0 file:bg-transparent file:font-medium file:text-accent-ink")}
            />
            <span id="people-import-file-hint" className="block text-xs text-muted">
              Checking the file changes nothing. You&apos;ll see who would be added first.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <button type="submit" aria-disabled={pending} className={primaryButton}>
              {pending ? <PendingLabel label="Checking…" /> : "Check file"}
            </button>
            <FormStatus state={state.status === "error" ? state : IMPORT_IDLE} />
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * The import flow: upload a file and check it, read what it would do, then add everyone
 * with one button. "Choose another file" starts over with a fresh form.
 */
export function ImportForm({ action }: { action: Action }) {
  const [round, setRound] = useState(0);
  return <Importer key={round} action={action} onStartOver={() => setRound((r) => r + 1)} />;
}
