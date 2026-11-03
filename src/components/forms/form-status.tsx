import { cx, errorText } from "@/components/ui/styles";
import type { FormState } from "./form-state";

/** A failure, announced as soon as it appears. */
export function ErrorMessage({
  as: Tag = "span",
  focusable = false,
  className,
  children,
}: {
  as?: "span" | "p";
  /** Lets code move focus here, e.g. inside a dialog whose button stays put. */
  focusable?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Tag role="alert" tabIndex={focusable ? -1 : undefined} className={cx(errorText, focusable && "outline-none", className)}>
      {children}
    </Tag>
  );
}

/**
 * The line beside a form's button that reports how the last submit went: the calm
 * success message in the accent colour, or the error. It stays mounted while idle, so
 * screen readers announce the next result.
 *
 * @param success Show success messages too (off where the page itself shows the change).
 */
export function FormStatus({
  state,
  success = true,
  ref,
}: {
  /** A form's result: `FormState`, or any state with the same `error` shape (a reveal, a feed link). */
  state: FormState | { status: string; message?: string };
  success?: boolean;
  /** Lets a caller move focus to the result; the line is then focusable. */
  ref?: React.Ref<HTMLParagraphElement>;
}) {
  return (
    <p ref={ref} tabIndex={ref ? -1 : undefined} aria-live="polite" className="min-h-5 text-sm outline-none">
      {state.status === "success" && success && <span className="text-accent">{state.message}</span>}
      {state.status === "error" && state.message && <ErrorMessage>{state.message}</ErrorMessage>}
    </p>
  );
}
