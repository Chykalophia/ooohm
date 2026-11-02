import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

/**
 * One process at a time per embedded data directory.
 *
 * PGlite is Postgres in single-user mode inside this process: two processes opening the
 * same directory would each believe they own the files and corrupt them. Every process
 * that opens it (the app, `pnpm db:migrate`, `pnpm db:seed`, the worker, the import)
 * first creates `<dir>.lock` exclusively, holding its pid, and removes it on exit. A lock
 * left by a process that no longer exists is taken over.
 */

export interface EmbeddedLock {
  readonly path: string;
  release(): void;
}

interface LockFile {
  pid: number;
  purpose: string;
  since: string;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(file: string): LockFile | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<LockFile>;
    return typeof parsed.pid === "number" ? { pid: parsed.pid, purpose: String(parsed.purpose ?? "unknown"), since: String(parsed.since ?? "") } : null;
  } catch {
    return null;
  }
}

/** The lock file for a data directory: a sibling, so PGlite's own directory stays untouched. */
export function lockPathFor(dataDir: string): string {
  return `${path.resolve(dataDir)}.lock`;
}

/**
 * Takes the directory's lock for this process.
 *
 * @param purpose Named in the error another process gets, e.g. "the app" or "pnpm worker".
 * @throws Error naming the process that holds it, when one does.
 */
export function acquireEmbeddedLock(dataDir: string, purpose: string): EmbeddedLock {
  const file = lockPathFor(dataDir);
  mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(file, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readLock(file);
      if (holder && holder.pid === process.pid) return { path: file, release: () => releaseIfOurs(file) };
      if (holder && isAlive(holder.pid)) {
        throw new Error(
          `The embedded database at ${path.resolve(dataDir)} is in use by ${holder.purpose} (process ${holder.pid}, since ${holder.since}). ` +
            "Embedded mode is single-process: the app runs background work itself, so do not start `pnpm worker` beside it, " +
            "and stop the app before running migrations, the seed or an import. " +
            `If no such process is running, delete ${file}.`,
        );
      }
      // Stale (its process is gone) or unreadable: take it over.
      try {
        unlinkSync(file);
      } catch {
        // Another process removed it first; the next attempt decides.
      }
      continue;
    }
    const content: LockFile = { pid: process.pid, purpose, since: new Date().toISOString() };
    writeSync(fd, JSON.stringify(content));
    closeSync(fd);
    const release = () => releaseIfOurs(file);
    process.once("exit", release);
    return { path: file, release };
  }
  throw new Error(`Could not lock the embedded database at ${path.resolve(dataDir)}. Try again.`);
}

function releaseIfOurs(file: string): void {
  if (readLock(file)?.pid !== process.pid) return;
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
  }
}
