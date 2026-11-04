/**
 * Class recipes for the app's controls, so every screen draws them the same way. Plain
 * strings, usable on any element (a `<button>`, a `<Link>`, a `<label>`) from server and
 * client components alike. Colours come from the theme tokens in `globals.css`.
 */

/** Joins class names, skipping empty values, so optional classes need no ternaries. */
export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

/** The keyboard focus outline every control shows. */
export const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink";

/** Text and inputs that report a failure. */
export const errorText = "text-danger";

/** `md`: a form's field. `sm`: a compact one, for toolbars such as a table's filters. */
export type FieldSize = "md" | "sm";

const FIELD_SIZE: Record<FieldSize, string> = {
  md: "rounded-lg px-3 py-2",
  // 16px text on phones: iOS Safari zooms the page into any field smaller than that.
  sm: "rounded-md px-2.5 py-1.5 text-base sm:text-sm",
};

/**
 * A field's edge and focus: a border of at least 3:1 against what surrounds it (WCAG
 * 1.4.11; `--field-border`, derived per theme), and an accent-ink border and ring while
 * it (or, for a date input, one of its parts) has focus. Every text field, select and
 * text area uses it, through {@link fieldClass} or with its own size and colour around it.
 */
export const fieldFrame = "border border-field outline-none focus-within:border-accent-ink focus-within:ring-2 focus-within:ring-accent-ink/20";

/** The classes of a text input or select. */
export function fieldClass(size: FieldSize = "md"): string {
  return cx("w-full bg-surface aria-[invalid=true]:border-danger", fieldFrame, FIELD_SIZE[size]);
}

export const field = fieldClass("md");

/**
 * A checkbox or radio drawn by the browser, in the accent ink: the fill accent of the
 * light themes (Marigold, Saffron) is about 2:1 on white, under the 3:1 a checked state needs.
 */
export const nativeCheck = "h-4 w-4 shrink-0 accent-[var(--accent-ink)]";

/**
 * - `primary`: the screen's one main action (filled).
 * - `accent`: a way to the main action from elsewhere, outlined so it never competes with it.
 * - `outline`: a secondary action that still needs to look like a button.
 * - `danger`: the confirm button of an irreversible action, such as deleting a person.
 */
export type ButtonVariant = "primary" | "accent" | "outline" | "danger";
export type ButtonSize = "md" | "sm";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-foreground",
  accent: "border border-accent text-accent-ink hover:bg-accent/10",
  outline: "border border-border text-foreground hover:bg-background",
  danger: "border border-danger text-danger hover:bg-danger-soft",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  md: "px-4 py-2",
  sm: "px-3 py-1.5 text-sm",
};

/** The classes of a button-shaped control. */
export function buttonClass(variant: ButtonVariant, size: ButtonSize = "md"): string {
  return cx(
    // Corners follow the company theme (`--button-radius`, Admin → Appearance).
    "inline-flex items-center justify-center rounded-(--button-radius) font-medium disabled:opacity-60 aria-disabled:opacity-60",
    BUTTON_VARIANT[variant],
    BUTTON_SIZE[size],
    focusRing,
  );
}

export const primaryButton = buttonClass("primary");
export const outlineButton = buttonClass("outline", "sm");
export const dangerOutlineButton = buttonClass("danger");

/** A quiet text action. */
export const subtleButton = `inline-flex min-h-6 items-center rounded-md text-sm text-muted hover:text-foreground disabled:opacity-60 aria-disabled:opacity-60 ${focusRing}`;

/** The "Yes, …" of a question that replaces something rather than removing it. */
export const confirmButton = `rounded-md text-sm font-medium text-foreground hover:underline underline-offset-4 disabled:opacity-60 aria-disabled:opacity-60 ${focusRing}`;

/**
 * A quiet text action that removes or switches something off. On hover it gains a faint
 * danger background and an underline, so it reads as something to click; the padding is
 * taken back with negative margins, so it sits where plain text would.
 */
export const dangerButton = `-mx-1.5 -my-0.5 inline-flex min-h-6 items-center rounded-md px-1.5 py-0.5 text-sm font-medium ${errorText} underline-offset-4 transition-colors hover:bg-danger-soft hover:text-danger-strong hover:underline disabled:opacity-60 aria-disabled:opacity-60 ${focusRing}`;

/** A link inside running text. */
export const textLink = `rounded-md underline-offset-4 hover:underline ${focusRing}`;

/** A link that stays muted until hovered, for asides at the bottom of a page. */
export const quietLink = `rounded-md text-muted underline-offset-4 hover:text-foreground hover:underline ${focusRing}`;

/** The bordered, raised background of cards and lists. */
export const surface = "rounded-2xl border border-border bg-surface";

export const card = `${surface} p-5 sm:p-6`;

/** A rounded pill used as a filter or section switch; `active` marks the current one. */
export function pillClass(active: boolean): string {
  return cx(
    "rounded-full border px-3 py-1",
    focusRing,
    active ? "border-accent text-accent-ink" : "border-border text-muted hover:text-foreground",
  );
}

/** A table's header cell: small, muted, and stuck to the top while its rows scroll by. */
export const tableHeadCell =
  "sticky top-0 z-10 bg-surface px-3 py-2.5 text-left text-xs font-medium text-muted shadow-[inset_0_-1px_0_var(--border)] first:pl-4 last:pr-4";

/** A table's body cell: one compact line, divided from the row above. */
export const tableCell = "border-t border-border px-3 py-2 align-top first:pl-4 last:pr-4";
