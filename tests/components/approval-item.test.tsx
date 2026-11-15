import { afterEach, before, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { FormState } from "@/components/forms/form-state";
import { router, stubModule } from "./setup";

let answer: (data: Record<string, FormDataEntryValue>) => FormState;
stubModule("@/app/approvals/actions", {
  decideLeaveAction: async (_prev: FormState, formData: FormData): Promise<FormState> => answer(Object.fromEntries(formData)),
});

let ApprovalItem: typeof import("@/app/approvals/approval-item").ApprovalItem;
before(async () => ({ ApprovalItem } = await import("@/app/approvals/approval-item")));

/** How long a decided card holds its outcome, then folds away (approval-item.tsx). */
const HOLD_MS = 1600;
const COLLAPSE_MS = 300;

beforeEach(() => {
  answer = (data) => ({ status: "success", message: data.decision === "reject" ? "Declined." : "Approved.", id: "s1" });
  mock.timers.enable({ apis: ["setTimeout"] });
});
afterEach(() => mock.timers.reset());

function renderList() {
  render(
    <main id="main" tabIndex={-1}>
      <ul>
        <ApprovalItem requestId="r1" label="Ada, Aug 3" who="Ada" dates="Mon, Aug 3">
          <p>Ada asks for Aug 3</p>
        </ApprovalItem>
        <ApprovalItem requestId="r2" label="Grace, Aug 10" who="Grace" dates="Mon, Aug 10">
          <p>Grace asks for Aug 10</p>
        </ApprovalItem>
      </ul>
    </main>,
  );
  return { first: screen.getByRole("group", { name: "Ada, Aug 3" }), second: screen.getByRole("group", { name: "Grace, Aug 10" }) };
}

/** Presses a decision button and lets the stubbed action answer. */
async function decide(card: HTMLElement, button: "Approve" | "Decline") {
  const el = within(card).getByRole("button", { name: button });
  el.focus();
  await act(async () => void fireEvent.click(el));
}

async function advance(ms: number) {
  await act(async () => mock.timers.tick(ms));
}

describe("ApprovalItem", () => {
  test("an approval turns the card into its outcome, and focus follows it", async () => {
    const { first } = renderList();
    await decide(first, "Approve");

    const outcome = within(first).getByRole("status");
    assert.match(outcome.textContent ?? "", /Approved/);
    assert.match(outcome.textContent ?? "", /Ada is off Mon, Aug 3\./);
    assert.equal(document.activeElement, outcome);
    assert.equal(within(first).queryByRole("button", { name: "Approve" }), null);
  });

  test("a decline says so", async () => {
    const { first } = renderList();
    await decide(first, "Decline");

    assert.match(within(first).getByRole("status").textContent ?? "", /Ada’s request for Mon, Aug 3 is declined\./);
  });

  test("a decided card leaves the shortcut list at once, then collapses and refreshes the page", async () => {
    const { first, second } = renderList();
    await decide(first, "Approve");

    assert.deepEqual([...document.querySelectorAll("[data-approval]")], [second]);
    assert.equal(router.refreshes, 0);
    await advance(HOLD_MS);
    assert.equal(router.refreshes, 0, "the outcome holds before the card goes");
    await advance(COLLAPSE_MS);
    assert.equal(router.refreshes, 1);
  });

  test("when the decided card had focus, focus moves on to the next request", async () => {
    const { first, second } = renderList();
    await decide(first, "Approve");
    await advance(HOLD_MS + COLLAPSE_MS);

    assert.equal(document.activeElement, second);
  });

  test("with no request after it, focus moves to the previous one", async () => {
    const { first, second } = renderList();
    await decide(second, "Decline");
    await advance(HOLD_MS + COLLAPSE_MS);

    assert.equal(document.activeElement, first);
  });

  test("with no request left, the page keeps focus", async () => {
    const { first, second } = renderList();
    await decide(first, "Approve");
    await decide(second, "Approve");
    await advance(HOLD_MS + COLLAPSE_MS);

    assert.equal(document.activeElement, document.getElementById("main"));
  });

  test("focus the person moved elsewhere stays where it is", async () => {
    const { first, second } = renderList();
    await decide(first, "Approve");
    const reason = within(second).getByRole("textbox", { name: /Reason/ });
    reason.focus();
    await advance(HOLD_MS + COLLAPSE_MS);

    assert.equal(document.activeElement, reason);
  });

  test("a refused decision keeps the form, and the card stays", async () => {
    answer = () => ({ status: "error", message: "This request was cancelled." });
    const { first } = renderList();
    await decide(first, "Approve");
    await advance(HOLD_MS + COLLAPSE_MS);

    assert.equal(within(first).getByRole("alert").textContent, "This request was cancelled.");
    assert.ok(within(first).getByRole("button", { name: "Approve" }));
    assert.equal(router.refreshes, 0);
  });
});
