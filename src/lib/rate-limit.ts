/**
 * A fixed-window rate limiter held in process memory.
 *
 * For cheap read endpoints where a per-process limit is enough (the app runs as one
 * standalone server); limits that must hold across restarts or instances, like
 * submit's, are counted in the database instead.
 */
export interface RateLimiter {
  /** Counts one hit for `key`; false when `key` is already at the limit for this window. */
  take(key: string): boolean;
}

export function createRateLimiter(options: { limit: number; windowMs: number; now?: () => number }): RateLimiter {
  const { limit, windowMs, now = Date.now } = options;
  const windows = new Map<string, { start: number; count: number }>();
  let lastSweep = now();

  return {
    take(key) {
      const at = now();
      // At most once a window, drop expired windows, so memory holds only recent keys.
      if (at - lastSweep >= windowMs) {
        for (const [k, w] of windows) if (at - w.start >= windowMs) windows.delete(k);
        lastSweep = at;
      }
      const current = windows.get(key);
      if (!current || at - current.start >= windowMs) {
        windows.set(key, { start: at, count: 1 });
        return true;
      }
      if (current.count >= limit) return false;
      current.count++;
      return true;
    },
  };
}
