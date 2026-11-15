import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** The repository root; every path these tests report is relative to it. */
export const ROOT = join(import.meta.dirname, "..", "..");

/** Every file under `dir` (relative to the root) whose name matches `pattern`, as root-relative paths. */
export function listFiles(dir: string, pattern: RegExp): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs)) {
      const path = join(abs, name);
      if (statSync(path).isDirectory()) {
        // fitness.test.ts plants rule-breaking probes here while it runs; other scans skip them.
        if (name !== "__fitness_probe__") walk(path);
      }
      else if (pattern.test(name)) out.push(relative(ROOT, path).split("\\").join("/"));
    }
  };
  walk(join(ROOT, dir));
  return out.sort();
}

export function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** True when the file opens with the given directive (`"use server"`, `"use client"`). */
export function hasDirective(source: string, directive: string): boolean {
  return new RegExp(`^\\s*(?:\\/\\/[^\\n]*\\n\\s*)*["']${directive}["']`).test(source);
}
