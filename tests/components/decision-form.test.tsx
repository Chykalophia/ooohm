import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FormState } from "@/components/forms/form-state";
import { stubModule } from "./setup";

type Call = Record<string, FormDataEntryValue>;
const calls: Call[] = [];
let answer: (data: Call) => FormState;

stubModule("@/app/approvals/actions", {
  decideLeaveAction: async (_prev: FormState, formData: FormData): Promise<FormState> => {
    const data = Object.fromEntries(formData) as Call;
    calls.push(data);
    return answer(data);
  },
});

let DecisionForm: typeof import("@/app/approvals/decision-form").DecisionForm;
let DECLINE_EVENT: string;
before(async () => {
  ({ DecisionForm } = await import("@/app/approvals/decision-form"));
  ({ DECLINE_EVENT } = await import("@/app/approvals/approval-keys"));
});

beforeEach(() => {
  calls.length = 0;
  answer = (data) => ({ status: "success", message: data.decision === "reject" ? "Declined." : "Approved.", id: "s1" });
});

function renderForm() {
  const decided: string[] = [];
  render(<DecisionForm requestId="req-1" onDecided={(d) => decided.push(d)} />);
  return { decided, reason: screen.getByRole("textbox", { name: /Reason/ }) };
}

describe("DecisionForm", () => {
  test("Approve sends the request, the decision and the reason, then reports the outcome", async () => {
    const user = userEvent.setup();
    const { decided, reason } = renderForm();
    await user.type(reason, "Enjoy it");
    await user.click(screen.getByRole("button", { name: "Approve" }));

    assert.deepEqual(calls, [{ requestId: "req-1", decision: "approve", reason: "Enjoy it" }]);
    assert.deepEqual(decided, ["approve"]);
    assert.ok(screen.getByText("Approved."));
    assert.equal(screen.queryByRole("button", { name: "Approve" }), null);
  });

  test("Decline reports a rejection, read from the server's answer", async () => {
    const user = userEvent.setup();
    const { decided } = renderForm();
    await user.click(screen.getByRole("button", { name: "Decline" }));

    assert.equal(calls[0]?.decision, "reject");
    assert.deepEqual(decided, ["reject"]);
  });

  test("a refused decision shows the error and keeps the reason as typed", async () => {
    answer = () => ({ status: "error", message: "Someone else already decided this request." });
    const user = userEvent.setup();
    const { decided, reason } = renderForm();
    await user.type(reason, "Busy week");
    await user.click(screen.getByRole("button", { name: "Decline" }));

    assert.equal(screen.getByRole("alert").textContent, "Someone else already decided this request.");
    assert.equal((screen.getByRole("textbox", { name: /Reason/ }) as HTMLInputElement).value, "Busy week");
    assert.deepEqual(decided, []);
    assert.ok(reason.isConnected);
  });

  test("Enter in the reason field does not approve", async () => {
    const user = userEvent.setup();
    const { decided, reason } = renderForm();
    await user.type(reason, "Not sure yet{Enter}");

    assert.deepEqual(calls, []);
    assert.deepEqual(decided, []);
  });

  test("the D shortcut moves focus to the reason, and Enter there declines", async () => {
    const user = userEvent.setup();
    const { decided, reason } = renderForm();
    act(() => void reason.closest("form")!.dispatchEvent(new CustomEvent(DECLINE_EVENT)));

    assert.equal(document.activeElement, reason);
    assert.equal(reason.getAttribute("placeholder"), "Why, then Enter to decline");
    await user.keyboard("Team offsite{Enter}");

    assert.deepEqual(calls, [{ requestId: "req-1", decision: "reject", reason: "Team offsite" }]);
    assert.deepEqual(decided, ["reject"]);
  });

  test("Escape takes the D shortcut back: Enter then does nothing", async () => {
    const user = userEvent.setup();
    const { reason } = renderForm();
    act(() => void reason.closest("form")!.dispatchEvent(new CustomEvent(DECLINE_EVENT)));
    fireEvent.keyDown(reason, { key: "Escape" });
    await user.keyboard("{Enter}");

    assert.equal(reason.getAttribute("placeholder"), null);
    assert.deepEqual(calls, []);
  });
});
