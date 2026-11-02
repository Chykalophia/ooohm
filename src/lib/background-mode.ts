/**
 * Who runs OOOhm's background work: fanning events out to webhooks and adapters,
 * delivering them with retries, and the daily jobs (year rollover, retention).
 *
 * - `worker`: a long-running `pnpm worker` process does it all (Docker compose, a VM).
 *   The app does nothing in the background.
 * - `inline`: the app runs a short tick right after each change that queued outbound
 *   work, after the response is sent (`after()`), so webhooks go out within seconds with
 *   no worker. Retries and the daily jobs need a scheduler calling `/api/cron/tick` too
 *   (Vercel Cron), or, in embedded mode, the in-process interval runner.
 * - `cron`: only `/api/cron/tick`, called by an external scheduler, does the work.
 *
 * The default: `inline` on Vercel and in embedded mode, `worker` everywhere else (the
 * compose files also set it explicitly).
 */
export const BACKGROUND_MODES = ["worker", "inline", "cron"] as const;
export type BackgroundMode = (typeof BACKGROUND_MODES)[number];

export function isBackgroundMode(value: string): value is BackgroundMode {
  return (BACKGROUND_MODES as readonly string[]).includes(value);
}

/**
 * @param configured `OOOHM_BACKGROUND`, if set.
 * @throws Error for `worker` in embedded mode, where no second process may open the database.
 */
export function resolveBackgroundMode(configured: BackgroundMode | undefined, context: { vercel: boolean; embedded: boolean }): BackgroundMode {
  if (configured === "worker" && context.embedded) {
    throw new Error("OOOHM_BACKGROUND=worker does not work with the embedded database: only one process may open it. Use inline (the default) or cron.");
  }
  if (configured) return configured;
  return context.vercel || context.embedded ? "inline" : "worker";
}
