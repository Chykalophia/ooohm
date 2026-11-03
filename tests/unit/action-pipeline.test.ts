import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createActionPipeline } from "@/app/_lib/action-pipeline";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import type { ServiceContext } from "@/server/context";

const actorOf = (role: Actor["role"]): Actor => ({
  id: "u1",
  companyId: "c1",
  role,
  canSelfApprove: false,
  source: { kind: "user", userId: "u1" },
});

/** A pipeline over fakes that records what happened, in order. */
function harness(actor: Actor | null = actorOf("employee")) {
  const calls: string[] = [];
  const pipeline = createActionPipeline({
    actor: async () => {
      calls.push("session");
      return actor;
    },
    context: () => ({}) as ServiceContext,
    refresh: () => calls.push("refresh"),
    redirect: (path) => {
      calls.push(`redirect ${path}`);
      throw new Error("NEXT_REDIRECT");
    },
  });
  return { calls, ...pipeline };
}

const schema = z.object({ name: z.string().min(1) });
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

test("a success runs the service with the parsed input, then refreshes once", async () => {
  const h = harness();
  const state = await h.runFormAction("t", form({ name: "Ana", extra: "x" }), schema, async (_ctx, actor, input) => {
    h.calls.push(`work ${actor.id} ${JSON.stringify(input)}`);
    return "Saved.";
  });
  assert.equal(state.status, "success");
  assert.equal(state.status === "success" && state.message, "Saved.");
  assert.deepEqual(h.calls, ["session", 'work u1 {"name":"Ana"}', "refresh"]);
});

test("a refused service call never refreshes, and says why calmly", async () => {
  const h = harness();
  const state = await h.runFormAction("t", form({ name: "Ana" }), schema, async () => {
    throw new DomainError("forbidden", "no");
  });
  // The calm message for a refusal, not the generic failure, which is also an error.
  assert.deepEqual(state, { status: "error", message: "You can't change that request." });
  assert.deepEqual(h.calls, ["session"]);
});

test("refresh: false keeps the page as it is after a success", async () => {
  const h = harness();
  const state = await h.runFormAction("t", form({ name: "Ana" }), schema, async () => "Done.", { refresh: false });
  assert.equal(state.status, "success");
  assert.deepEqual(h.calls, ["session"]);
});

test("an admin action refuses a non-admin before parsing or calling the service", async () => {
  const h = harness(actorOf("manager"));
  let parsed = false;
  const spySchema = z.object({ name: z.string().transform((v) => ((parsed = true), v)) });
  const state = await h.runFormAction("t", form({ name: "Ana" }), spySchema, async () => "never", { who: "admin" });
  assert.deepEqual(state, { status: "error", message: "Only admins can do that." });
  assert.equal(parsed, false, "the form is not parsed");
  assert.deepEqual(h.calls, ["session"]);
});

test("without a company, nothing runs", async () => {
  const h = harness(null);
  const state = await h.runFormAction("t", form({ name: "Ana" }), schema, async () => "never");
  assert.equal(state.status, "error");
  assert.deepEqual(h.calls, ["session"]);
});

test("input the schema refuses gets the action's own message when it has one", async () => {
  const generic = await harness().runFormAction("t", form({ name: "" }), schema, async () => "never");
  const own = await harness().runFormAction("t", form({ name: "" }), schema, async () => "never", {
    invalidInput: "Names are 1 to 100 characters.",
  });
  assert.equal(generic.status === "error" && generic.message, "Some details aren't valid. Check the form and try again.");
  assert.equal(own.status === "error" && own.message, "Names are 1 to 100 characters.");
});

test("a state action refreshes after any state but an error", async () => {
  const h = harness();
  await h.runStateAction("t", { name: "Ana" }, schema, async () => ({ status: "off" as const }));
  assert.deepEqual(h.calls, ["session", "refresh"]);
});

test("then-go redirects after a success without refreshing, and stays put on a refusal", async () => {
  const ok = harness();
  await assert.rejects(
    ok.runActionThenGo("t", form({ name: "Ana" }), schema, async () => "/admin/people"),
    /NEXT_REDIRECT/,
  );
  assert.deepEqual(ok.calls, ["session", "redirect /admin/people"]);

  const refused = harness();
  const state = await refused.runActionThenGo("t", form({ name: "Ana" }), schema, async () => {
    throw new DomainError("deletion_blocked", "no");
  });
  assert.equal(state.status, "error");
  assert.deepEqual(refused.calls, ["session"]);
});
