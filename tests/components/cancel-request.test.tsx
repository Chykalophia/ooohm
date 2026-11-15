import { afterEach, before, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { FormState } from "@/components/forms/form-state";
import { stubModule } from "./setup";

const sent: string[] = [];
let answer: () => FormState;
const idle = async (): Promise<FormState> => ({ status: "idle" });
stubModule("@/app/actions", {
  cancelLeaveAction: async (_prev: FormState, formData: FormData): Promise<FormState> => {
    sent.push(String(formData.get("requestId")));
    return answer();
  },
  requestLeaveAction: idle,
  addLeaveForAction: idle,
});

let CancelRequest: typeof import("@/app/requests/cancel-request").CancelRequest;
before(async () => ({ CancelRequest } = await import("@/app/requests/cancel-request")));

beforeEach(() => {
  sent.length = 0;
  answer = () => ({ status: "success", message: "Cancelled.", id: "c1" });
  mock.timers.enable({ apis: ["setTimeout"] });
});
afterEach(() => mock.timers.reset());

const request = { id: "req-7", startDate: "2026-08-03", endDate: "2026-08-05", dayPortion: "full" as const };

function renderCancel() {
  return render(
    <>
      <h2 id="your-requests" tabIndex={-1}>
        Your requests
      </h2>
      <CancelRequest request={request} focusOnSuccess="your-requests" />
    </>,
  );
}

const cancelButton = () => screen.getByRole("button", { name: "Cancel request for Mon, Aug 3 to Wed, Aug 5, 2026" });
/** Lets the component's requestAnimationFrame focus move run (jsdom's frames run on real time). */
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function seconds(n: number) {
  for (let i = 0; i < n; i++) await act(async () => mock.timers.tick(1000));
}

async function start() {
  act(() => void fireEvent.click(cancelButton()));
  await act(nextFrame);
}

describe("CancelRequest", () => {
  test("names the request it cancels", () => {
    renderCancel();
    assert.ok(cancelButton());
  });

  test("Cancel request starts a countdown with Undo, which takes focus; nothing is sent yet", async () => {
    renderCancel();
    await start();

    const undo = screen.getByRole("button", { name: "Undo" });
    assert.equal(document.activeElement, undo);
    assert.match(document.body.textContent ?? "", /Cancelling in 20s/);
    assert.match(document.body.textContent ?? "", /in 20 seconds\. Undo keeps it\./);
    assert.equal(screen.queryByRole("button", { name: /Cancel request/ }), null);
    assert.deepEqual(sent, []);
  });

  test("the countdown ticks down each second", async () => {
    renderCancel();
    await start();
    await seconds(5);

    assert.match(document.body.textContent ?? "", /Cancelling in 15s/);
    assert.deepEqual(sent, []);
  });

  test("Undo keeps the request: nothing is sent, and focus returns to Cancel request", async () => {
    renderCancel();
    await start();
    await seconds(3);
    act(() => void fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    await act(nextFrame);
    await seconds(25);

    assert.deepEqual(sent, []);
    assert.equal(document.activeElement, cancelButton());
    assert.doesNotMatch(document.body.textContent ?? "", /Cancelling/);
  });

  test("when the countdown ends the cancel is sent once, and focus moves to the given element", async () => {
    renderCancel();
    await start();
    await seconds(20);

    assert.deepEqual(sent, ["req-7"]);
    assert.equal(document.activeElement, screen.getByRole("heading", { name: "Your requests" }));
    await seconds(5);
    assert.deepEqual(sent, ["req-7"]);
  });

  test("leaving the page during the countdown sends the cancel at once, and only once", async () => {
    const view = renderCancel();
    await start();
    act(() => void window.dispatchEvent(new Event("pagehide")));
    assert.deepEqual(sent, ["req-7"]);

    view.unmount();
    await seconds(25);
    assert.deepEqual(sent, ["req-7"]);
  });

  test("navigating away (unmounting) during the countdown sends it", async () => {
    const view = renderCancel();
    await start();
    view.unmount();

    assert.deepEqual(sent, ["req-7"]);
  });

  test("a refused cancel says why and offers Cancel request again", async () => {
    answer = () => ({ status: "error", message: "This request has already started." });
    renderCancel();
    await start();
    await seconds(20);

    assert.equal(screen.getByRole("alert").textContent, "This request has already started.");
    assert.ok(cancelButton());
  });
});
