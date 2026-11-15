import { randomUUID } from "node:crypto";

/** Where new record ids come from (ADR-0002), so tests can pin them. */
export interface IdGenerator {
  next(): string;
}

/** Random UUIDs: what the app, scripts and the worker use. */
export const uuidGenerator: IdGenerator = { next: () => randomUUID() };

/** Predictable UUIDs for tests: `00000000-0000-4000-8000-000000000001`, `…02`, and so on. */
export function sequenceIds(start = 1): IdGenerator {
  let n = start;
  return {
    next: () => `00000000-0000-4000-8000-${(n++).toString(16).padStart(12, "0")}`,
  };
}
