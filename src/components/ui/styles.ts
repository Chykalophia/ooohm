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
export const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** Text and inputs that report a failure. */
export const errorText = "text-red-700 dark:text-red-400";

export const field =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 aria-[invalid=true]:border-red-700";

/** A checkbox or radio drawn by the browser, in the accent colour. */
export const nativeCheck = "h-4 w-4 shrink-0 accent-[var(--accent)]";

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
  accent: "border border-accent text-accent hover:bg-accent/10",
  outline: "border border-border text-foreground hover:bg-background",
  danger: "border border-red-700 text-red-700 hover:bg-red-50 dark:border-red-400 dark:text-red-400 dark:hover:bg-red-950",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  md: "px-4 py-2",
  sm: "px-3 py-1.5 text-sm",
};

/** The classes of a button-shaped control. */
export function buttonClass(variant: ButtonVariant, size: ButtonSize = "md"): string {
  return cx(
    "inline-flex items-center justify-center rounded-lg font-medium disabled:opacity-60",
    BUTTON_VARIANT[variant],
    BUTTON_SIZE[size],
    focusRing,
  );
}

export const primaryButton = buttonClass("primary");
export const outlineButton = buttonClass("outline", "sm");
export const dangerOutlineButton = buttonClass("danger");

/** A quiet text action. */
export const subtleButton = `rounded-md text-sm text-muted hover:text-foreground disabled:opacity-60 ${focusRing}`;

/** A quiet text action that removes or switches something off. */
export const dangerButton = `rounded-md text-sm font-medium ${errorText} hover:text-red-800 disabled:opacity-60 ${focusRing}`;

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
    active ? "border-accent text-accent" : "border-border text-muted hover:text-foreground",
  );
}
