import { afterEach, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { act, renderHook } from "@testing-library/react";
import { PREVIEW_DELAY_MS, type PreviewDraft, useLeavePreview } from "@/app/use-leave-preview";

/** Every preview request the hook made, and a way to answer or fail each one. */
type Call = { params: URLSearchParams; init: RequestInit | undefined; settle: (body: unknown) => Promise<void>; fail: () => Promise<void> };
let calls: Call[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  mock.timers.enable({ apis: ["setTimeout"] });
  globalThis.fetch = ((input: string, init?: RequestInit) =>
    new Promise((resolve, reject) => {
      const url = new URL(input, "http://localhost");
      assert.equal(url.pathname, "/api/leave-preview");
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      calls.push({
        params: url.searchParams,
        init,
        settle: (body) => act(async () => resolve({ json: async () => body } as Response)),
        fail: () => act(async () => reject(new TypeError("Failed to fetch"))),
      });
    })) as typeof fetch;
});
afterEach(() => {
  mock.timers.reset();
  globalThis.fetch = realFetch;
});

const draft = (over: Partial<PreviewDraft> = {}): PreviewDraft => ({
  leaveTypeId: "vacation",
  startDate: "2026-08-03",
  endDate: "2026-08-03",
  dayPortion: "full",
  ...over,
});

/** Lets the debounce run out. */
const wait = () => act(async () => mock.timers.tick(PREVIEW_DELAY_MS));

function renderPreview(initial: PreviewDraft, forUserId?: string) {
  type Props = { d: PreviewDraft; who?: string };
  return renderHook(({ d, who }: Props) => useLeavePreview(d, who), { initialProps: { d: initial, who: forUserId } as Props });
}

describe("useLeavePreview", () => {
  test("starts empty and asks nothing until the debounce runs out", async () => {
    const { result } = renderPreview(draft());
    assert.deepEqual(result.current, { message: "", ok: true, current: true });
    await act(async () => mock.timers.tick(PREVIEW_DELAY_MS - 1));
    assert.equal(calls.length, 0);
    await act(async () => mock.timers.tick(1));
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.fromEntries(calls[0]!.params), draft());
    assert.equal(calls[0]!.init?.cache, "no-store");
  });

  test("shows the server's sentence, and whether the draft can be sent", async () => {
    const { result } = renderPreview(draft());
    await wait();
    await calls[0]!.settle({ ok: false, message: "That's more than you have left." });
    assert.deepEqual(result.current, { message: "That's more than you have left.", ok: false, current: true });
  });

  test("asks for someone else with for=", async () => {
    renderPreview(draft(), "u2");
    await wait();
    assert.equal(calls[0]!.params.get("for"), "u2");
  });

  test("an incomplete draft asks nothing and shows nothing", async () => {
    const { result } = renderPreview(draft({ leaveTypeId: "" }));
    await wait();
    assert.equal(calls.length, 0);
    assert.deepEqual(result.current, { message: "", ok: true, current: true });
  });

  test("a change keeps the last answer, marked not current, and aborts the older request", async () => {
    const { result, rerender } = renderPreview(draft());
    await wait();
    await calls[0]!.settle({ ok: true, message: "Takes 1 day." });

    rerender({ d: draft({ dayPortion: "am" }) });
    assert.deepEqual(result.current, { message: "Takes 1 day.", ok: true, current: false });
    await wait();
    assert.equal(calls.length, 2);

    // A third draft before the second answers: the second request is aborted.
    rerender({ d: draft({ dayPortion: "pm" }) });
    assert.equal(calls[1]!.init?.signal?.aborted, true);
    await wait();
    await calls[2]!.settle({ ok: true, message: "Takes 0.5 days." });
    assert.deepEqual(result.current, { message: "Takes 0.5 days.", ok: true, current: true });
  });

  test("changes inside the debounce make one request, for the latest draft", async () => {
    const { rerender } = renderPreview(draft());
    await act(async () => mock.timers.tick(PREVIEW_DELAY_MS / 2));
    rerender({ d: draft({ endDate: "2026-08-05" }) });
    await wait();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.params.get("endDate"), "2026-08-05");
  });

  test("a failed request says the preview isn't available, and can't be sent", async () => {
    const { result } = renderPreview(draft());
    await wait();
    await calls[0]!.fail();
    assert.deepEqual(result.current, { message: "The preview isn't available right now.", ok: false, current: true });
  });
});
