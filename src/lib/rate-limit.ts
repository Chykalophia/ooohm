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
  /** How many keys the limiter holds right now. */
  readonly size: number;
}

/** Keys held at most, unless a limiter asks for another cap. */
export const DEFAULT_MAX_KEYS = 10_000;

/**
 * @param options.maxKeys Most keys held at once. When a new key arrives at the cap, the
 *   key whose window started first is dropped, so memory stays bounded however many
 *   distinct keys a client invents. A dropped key starts a fresh window if it returns.
 */
export function createRateLimiter(options: { limit: number; windowMs: number; maxKeys?: number; now?: () => number }): RateLimiter {
  const { limit, windowMs, maxKeys = DEFAULT_MAX_KEYS, now = Date.now } = options;
  // Insertion order is window-start order (a renewed key is re-inserted at the end), so
  // expired windows are always at the front and the oldest live one is first after them.
  const windows = new Map<string, { start: number; count: number }>();

  function dropExpired(at: number): void {
    for (const [k, w] of windows) {
      if (at - w.start < windowMs) break;
      windows.delete(k);
    }
  }

  function current(key: string, at: number) {
    dropExpired(at);
    return windows.get(key);
  }

  return {
    take(key) {
      const at = now();
      const window = current(key, at);
      if (window) {
        if (window.count >= limit) return false;
        window.count++;
        return true;
      }
      if (windows.size >= maxKeys) windows.delete(windows.keys().next().value!);
      windows.set(key, { start: at, count: 1 });
      return true;
    },
    get size() {
      return windows.size;
    },
  };
}
