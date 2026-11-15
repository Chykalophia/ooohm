import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type DueScrub, type DueScrubOutcome, SCRUB_CHECKS_PER_RUN, sweepDueScrubs } from "@/modules/people/application/use-cases/run-due-scrubs";

/** The daily scrub job's paging on fakes: what it runs, in what order, and when it stops. */
function due(n: number, from = 0): DueScrub[] {
  return Array.from({ length: n }, (_, i) => ({ id: `u-${from + i}`, companyId: "c-1", scrubScheduledAt: new Date(Date.UTC(2026, 0, 1, 0, from + i)) }));
}

function sweepOver(all: DueScrub[], outcomeOf: (id: string) => DueScrubOutcome = () => "scrubbed") {
  const ran: string[] = [];
  const pages: number[] = [];
  return {
    ran,
    pages,
    sweep: {
      listDue: async (limit: number, cursor?: { at: Date; id: string }) => {
        pages.push(limit);
        const start = cursor ? all.findIndex((d) => d.id === cursor.id) + 1 : 0;
        return all.slice(start, start + limit);
      },
      runOne: async (id: string) => {
        ran.push(id);
        return outcomeOf(id);
      },
    },
  };
}

describe("sweeping due scrubs", () => {
  test("runs every due scrub, oldest first, page by page", async () => {
    const f = sweepOver(due(5));
    assert.deepEqual(await sweepDueScrubs(f.sweep, 2), { scrubbed: 2, blocked: 0 });
    assert.deepEqual(f.ran, ["u-0", "u-1"]);
  });

  test("a blocked scrub is passed over and counted; the ones after it still run", async () => {
    const f = sweepOver(due(4), (id) => (id === "u-1" ? "blocked" : "scrubbed"));
    assert.deepEqual(await sweepDueScrubs(f.sweep, 3), { scrubbed: 3, blocked: 1 });
    assert.deepEqual(f.ran, ["u-0", "u-1", "u-2", "u-3"]);
  });

  test("gone and failed scrubs count as neither, and do not stop the run", async () => {
    const f = sweepOver(due(3), (id) => (id === "u-0" ? "failed" : id === "u-1" ? "gone" : "scrubbed"));
    assert.deepEqual(await sweepDueScrubs(f.sweep, 50), { scrubbed: 1, blocked: 0 });
  });

  test("a row without a company is skipped without running", async () => {
    const f = sweepOver([{ id: "u-x", companyId: null, scrubScheduledAt: new Date() }, ...due(1)]);
    assert.deepEqual(await sweepDueScrubs(f.sweep, 50), { scrubbed: 1, blocked: 0 });
    assert.deepEqual(f.ran, ["u-0"]);
  });

  test("blocked scrubs cannot make a run endless: it stops after SCRUB_CHECKS_PER_RUN looked at", async () => {
    const f = sweepOver(due(SCRUB_CHECKS_PER_RUN + 100), () => "blocked");
    const result = await sweepDueScrubs(f.sweep, 50);
    assert.equal(result.blocked, SCRUB_CHECKS_PER_RUN);
    assert.equal(f.ran.length, SCRUB_CHECKS_PER_RUN);
  });

  test("nothing due runs nothing", async () => {
    const f = sweepOver([]);
    assert.deepEqual(await sweepDueScrubs(f.sweep, 50), { scrubbed: 0, blocked: 0 });
    assert.deepEqual(f.pages, [50]);
  });
});
