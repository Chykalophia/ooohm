import { useId } from "react";
import { cx, field, type FieldSize, fieldClass, nativeCheck, selectClass } from "./styles";

/**
 * Labelled form fields. Plain markup with no client state, so a server page can render
 * them inside a client form, and a client form can control them with `value` and
 * `onChange`. Each has a visible label tied to its control, and an optional hint tied
 * with `aria-describedby` (outside the label, so the control's name stays short for
 * screen readers).
 */

type FieldProps = {
  label: React.ReactNode;
  hint?: React.ReactNode;
  optional?: boolean;
  /** Classes for the wrapper, e.g. to size the field in a grid. */
  className?: string;
  /** `sm` for a compact toolbar field: smaller text, a small muted label. */
  size?: FieldSize;
};

function Hint({ id, children }: { id: string; children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <span id={id} className="block text-xs text-muted">
      {children}
    </span>
  );
}

/**
 * The label above a control and the hint below it; `control` receives the ids to use.
 * `describedBy` (the caller's own `aria-describedby`) is kept beside the hint's id.
 */
function FieldShell({
  label,
  hint,
  optional,
  className,
  size = "md",
  describedBy: own,
  control,
}: FieldProps & { describedBy?: string; control: (ids: { id: string; describedBy: string | undefined }) => React.ReactNode }) {
  const id = useId();
  return (
    <div className={cx(size === "sm" ? "space-y-1" : "space-y-1.5", className)}>
      <label htmlFor={id} className={size === "sm" ? "block text-xs font-medium text-muted" : "block text-sm font-medium"}>
        {label}
        {optional && <span className="font-normal text-muted"> (optional)</span>}
      </label>
      {control({ id, describedBy: [hint ? `${id}-hint` : undefined, own].filter(Boolean).join(" ") || undefined })}
      <Hint id={`${id}-hint`}>{hint}</Hint>
    </div>
  );
}

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "id" | "className" | "size"> & FieldProps;

export function TextField({ label, hint, optional, className, size, ...input }: InputProps) {
  return (
    <FieldShell
      label={label}
      hint={hint}
      optional={optional}
      className={className}
      size={size}
      describedBy={input["aria-describedby"]}
      control={({ id, describedBy }) => <input {...input} id={id} aria-describedby={describedBy} className={fieldClass(size)} />}
    />
  );
}

export function TextAreaField({
  label,
  hint,
  optional,
  className,
  ...textarea
}: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "id" | "className"> & Omit<FieldProps, "size">) {
  return (
    <FieldShell
      label={label}
      hint={hint}
      optional={optional}
      className={className}
      describedBy={textarea["aria-describedby"]}
      control={({ id, describedBy }) => <textarea {...textarea} id={id} aria-describedby={describedBy} className={cx(field, "resize-y")} />}
    />
  );
}

export type SelectOption = { value: string; label: string };

export function SelectField({
  label,
  hint,
  optional,
  className,
  size,
  options,
  ...select
}: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "id" | "className" | "size"> &
  FieldProps & {
    options: readonly SelectOption[];
  }) {
  return (
    <FieldShell
      label={label}
      hint={hint}
      optional={optional}
      className={className}
      size={size}
      describedBy={select["aria-describedby"]}
      control={({ id, describedBy }) => (
        <select {...select} id={id} aria-describedby={describedBy} className={selectClass(size)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    />
  );
}

/** A single on/off setting: the checkbox first, its label and hint beside it. */
export function CheckboxField({ label, hint, ...input }: Omit<InputProps, "type" | "optional" | "className" | "size">) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input
        {...input}
        id={id}
        type="checkbox"
        aria-describedby={[hint ? `${id}-hint` : undefined, input["aria-describedby"]].filter(Boolean).join(" ") || undefined}
        className={cx("mt-1", nativeCheck)}
      />
      <div className="space-y-0.5">
        <label htmlFor={id} className="block cursor-pointer text-sm font-medium">
          {label}
        </label>
        <Hint id={`${id}-hint`}>{hint}</Hint>
      </div>
    </div>
  );
}

/** A group of related controls under one legend, such as the working days. */
export function Fieldset({
  legend,
  hint,
  className = "space-y-2",
  children,
}: {
  legend: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className={className}>
      <legend className="text-sm font-medium">{legend}</legend>
      {children}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </fieldset>
  );
}

/**
 * One option of a {@link Fieldset} drawn as a bordered chip: a radio for one choice of a
 * few ("Morning"), a checkbox for any of several ("Monday"). The chip shows the accent
 * border while checked and dims while disabled.
 */
export function ChoiceChip({
  type,
  children,
  ...input
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "className"> & { type: "radio" | "checkbox" }) {
  return (
    <label
      className={cx(
        "flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm text-muted",
        "has-[:checked]:border-accent has-[:checked]:text-foreground has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/40",
        "has-[:disabled]:cursor-default has-[:disabled]:opacity-50",
      )}
    >
      <input {...input} type={type} className="accent-[var(--accent)]" />
      {children}
    </label>
  );
}
