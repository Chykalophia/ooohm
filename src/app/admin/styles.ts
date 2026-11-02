/** Class names shared by the admin screens, matching the rest of the app. */

export const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export const field =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 aria-[invalid=true]:border-red-700";

/** The screen's one main action. */
export const primaryButton = `inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2 font-medium text-accent-foreground disabled:opacity-60 ${focusRing}`;

/** A secondary action that still needs to look like a button. */
export const outlineButton = `inline-flex items-center justify-center rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-background disabled:opacity-60 ${focusRing}`;

/** A quiet text action. */
export const subtleButton = `rounded-md text-sm text-muted hover:text-foreground disabled:opacity-60 ${focusRing}`;

/** A quiet text action that removes or switches something off. */
export const dangerButton = `rounded-md text-sm font-medium text-red-700 hover:text-red-800 dark:text-red-400 disabled:opacity-60 ${focusRing}`;

/** The confirm button of an irreversible action, such as deleting a person. */
export const dangerOutlineButton = `inline-flex items-center justify-center rounded-lg border border-red-700 px-4 py-2 font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-400 dark:text-red-400 dark:hover:bg-red-950 ${focusRing}`;

export const card ="rounded-2xl border border-border bg-surface p-5 sm:p-6";

export const textLink = `rounded-md underline-offset-4 hover:underline ${focusRing}`;
