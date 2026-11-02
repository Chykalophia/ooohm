import { useId } from "react";
import { field } from "@/app/styles";

/**
 * Labelled form fields for the admin screens. Plain markup, so server pages can render
 * them inside a client `AdminForm`. Each has a visible label tied to its input, and an
 * optional hint tied with `aria-describedby` (outside the label, so the field's name
 * stays short for screen readers).
 */

function Hint({ id, children }: { id: string; children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <span id={id} className="block text-xs text-muted">
      {children}
    </span>
  );
}

function Label({ htmlFor, children, optional }: { htmlFor: string; children: React.ReactNode; optional?: boolean }) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-medium">
      {children}
      {optional && <span className="font-normal text-muted"> (optional)</span>}
    </label>
  );
}

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: string;
  hint?: React.ReactNode;
  optional?: boolean;
};

export function TextField({ label, hint, optional, className, ...input }: InputProps) {
  const id = useId();
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label htmlFor={id} optional={optional}>
        {label}
      </Label>
      <input {...input} id={id} aria-describedby={hint ? `${id}-hint` : undefined} className={field} />
      <Hint id={`${id}-hint`}>{hint}</Hint>
    </div>
  );
}

export function SelectField({
  label,
  hint,
  optional,
  className,
  options,
  ...select
}: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "id"> & {
  label: string;
  hint?: React.ReactNode;
  optional?: boolean;
  options: readonly { value: string; label: string }[];
}) {
  const id = useId();
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label htmlFor={id} optional={optional}>
        {label}
      </Label>
      <select {...select} id={id} aria-describedby={hint ? `${id}-hint` : undefined} className={field}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Hint id={`${id}-hint`}>{hint}</Hint>
    </div>
  );
}

export function CheckboxField({ label, hint, ...input }: Omit<InputProps, "type" | "optional">) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input
        {...input}
        id={id}
        type="checkbox"
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
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
