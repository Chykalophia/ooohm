import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { ACTION_RATE_LIMIT, createActionPipeline } from "@/app/_lib/action-pipeline";
import { createRateLimiter } from "@/lib/rate-limit";
import type { Actor } from "@/shared/kernel/actor";
import { DomainError } from "@/shared/kernel/errors";
import type { ServiceContext } from "@/server/context";
import { err, ok, type ServiceResult } from "@/shared/lib/result";

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

test("a refusal names the fields it is about, so the form can mark them", async () => {
  const bySchema = await harness().runFormAction("t", form({ name: "" }), schema, async () => "never");
  assert.deepEqual(bySchema.status === "error" && bySchema.fields, ["name"]);

  // A refusal of the input as a whole names no field.
  const whole = z.object({ name: z.string() }).refine((v) => v.name !== "x");
  const byRoot = await harness().runFormAction("t", form({ name: "x" }), whole, async () => "never");
  assert.equal(byRoot.status, "error");
  assert.equal("fields" in byRoot, false);

  const byDomain = await harness().runFormAction("t", form({ name: "a" }), schema, async () => {
    throw new DomainError("invalid_input", "That email is not valid.", { field: "email" });
  });
  assert.deepEqual(byDomain.status === "error" && byDomain.fields, ["email"]);
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

// ADR-0003: a use case may return a failed ServiceResult instead of throwing; the
// pipeline must treat both the same, so use cases can move to results one by one.
test("a returned failure gives exactly the state a thrown DomainError gives", async () => {
  const details = { year: 2026, requested: 3, remaining: 1, yearsSpanned: 1 };
  const thrown = harness();
  const threw = await thrown.runFormAction("t", form({ name: "Ana" }), schema, async () => {
    throw new DomainError("insufficient_balance", "short", details);
  });
  const returned = harness();
  const gave = await returned.runFormAction("t", form({ name: "Ana" }), schema, async () => err("insufficient_balance", "short", details));
  assert.deepEqual(gave, threw);
  assert.deepEqual(returned.calls, thrown.calls);
});

test("a returned success is unwrapped, for form, state and redirect actions", async () => {
  const h = harness();
  const saved = await h.runFormAction("t", form({ name: "Ana" }), schema, async () => ok("Saved."));
  assert.equal(saved.status === "success" && saved.message, "Saved.");
  const state = await h.runStateAction("t", form({ name: "Ana" }), schema, async () => ok({ status: "shown" as const, value: 1 }));
  assert.deepEqual(state, { status: "shown", value: 1 });
  await assert.rejects(h.runActionThenGo("t", form({ name: "Ana" }), schema, async () => ok("/people")), /NEXT_REDIRECT/);
  assert.ok(h.calls.includes("redirect /people"));
});

test("a returned failure from a state or redirect action is a calm error, with no redirect", async () => {
  const viaState = harness();
  const state = await viaState.runStateAction("t", form({ name: "Ana" }), schema, async (): Promise<ServiceResult<{ status: "shown" }>> => err("forbidden"));
  assert.deepEqual(state, { status: "error", message: "You can't change that request." });
  const viaGo = harness();
  const go = await viaGo.runActionThenGo("t", form({ name: "Ana" }), schema, async () => err("forbidden"));
  assert.deepEqual(go, { status: "error", message: "You can't change that request." });
  assert.ok(!viaGo.calls.some((c) => c.startsWith("redirect")));
});

/** A pipeline with a per-person action limit, acting as whoever `who()` names. */
function limited(limit: number, who: () => string = () => "u1") {
  const calls: string[] = [];
  const pipeline = createActionPipeline({
    actor: async () => ({ ...actorOf("employee"), id: who() }),
    context: () => ({}) as ServiceContext,
    refresh: () => calls.push("refresh"),
    redirect: () => {
      throw new Error("NEXT_REDIRECT");
    },
    limiter: createRateLimiter({ limit, windowMs: 60_000, now: () => 0 }),
  });
  return { calls, ...pipeline };
}

test("a person over the action rate limit is refused calmly, before parsing or calling the service", async () => {
  const h = limited(2);
  const work = async () => {
    h.calls.push("work");
    return "Saved.";
  };
  assert.equal((await h.runFormAction("t", form({ name: "Ana" }), schema, work)).status, "success");
  assert.equal((await h.runFormAction("t", form({ name: "Ana" }), schema, work)).status, "success");
  const third = await h.runFormAction("t", form({ name: "" }), schema, work);
  assert.deepEqual(third, { status: "error", message: "That's a lot of requests in a few minutes. Wait a little, then try again." });
  assert.deepEqual(h.calls, ["work", "refresh", "work", "refresh"]);
});

test("the action rate limit counts each person on their own", async () => {
  let who = "u1";
  const h = limited(1, () => who);
  assert.equal((await h.runFormAction("t", form({ name: "Ana" }), schema, async () => "ok")).status, "success");
  assert.equal((await h.runFormAction("t", form({ name: "Ana" }), schema, async () => "ok")).status, "error");
  who = "u2";
  assert.equal((await h.runFormAction("t", form({ name: "Ana" }), schema, async () => "ok")).status, "success");
});

test("the app's action limit is generous: a busy minute of clicking stays well inside it", () => {
  assert.ok(ACTION_RATE_LIMIT.limit / (ACTION_RATE_LIMIT.windowMs / 60_000) >= 60, "fewer than 60 actions a minute allowed");
});
