import { afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FormState } from "@/components/forms/form-state";
import { stubModule } from "./setup";

type Fields = Record<string, FormDataEntryValue>;
const submitted: { action: string; fields: Fields }[] = [];
let answer: (fields: Fields) => FormState;
const record = (action: string) => async (_prev: FormState, formData: FormData): Promise<FormState> => {
  const fields = Object.fromEntries(formData) as Fields;
  submitted.push({ action, fields });
  return answer(fields);
};
stubModule("@/app/actions", {
  requestLeaveAction: record("request"),
  addLeaveForAction: record("addFor"),
  cancelLeaveAction: record("cancel"),
});

let RequestLeaveForm: typeof import("@/app/request-leave-form").RequestLeaveForm;
before(async () => ({ RequestLeaveForm } = await import("@/app/request-leave-form")));

/** The preview endpoint, stubbed: every request it got, and how it answers. */
type PreviewCall = { params: URLSearchParams; signal: AbortSignal | undefined; settle: (body: unknown) => void; fail: () => void };
let previews: PreviewCall[] = [];
let autoAnswer: ((params: URLSearchParams) => unknown) | null;
const realFetch = globalThis.fetch;

beforeEach(() => {
  submitted.length = 0;
  previews = [];
  answer = () => ({ status: "success", message: "Sent to your manager.", id: crypto.randomUUID() });
  autoAnswer = (p) => ({ ok: true, message: `Takes ${p.get("dayPortion") === "full" ? "1 day" : "0.5 days"} of ${p.get("leaveTypeId")}.` });
  globalThis.fetch = ((input: string, init?: RequestInit) =>
    new Promise((resolve, reject) => {
      const url = new URL(input, "http://localhost");
      assert.equal(url.pathname, "/api/leave-preview");
      const signal = init?.signal ?? undefined;
      const respond = (body: unknown) => resolve({ json: async () => body } as Response);
      const call: PreviewCall = { params: url.searchParams, signal, settle: respond, fail: () => reject(new TypeError("Failed to fetch")) };
      previews.push(call);
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      if (autoAnswer) respond(autoAnswer(url.searchParams));
    })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const leaveTypes = [
  { id: "vacation", name: "Vacation", color: "#0d9488" },
  { id: "sick", name: "Sick leave", color: "#f97316" },
];

function renderForm(props: Partial<Parameters<typeof RequestLeaveForm>[0]> = {}) {
  render(<RequestLeaveForm leaveTypes={leaveTypes} defaultDate="2026-08-03" {...props} />);
}

const preview = () => document.getElementById("leave-preview")!;
const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLInputElement;

/** Opens the date field's calendar and types a date into it. */
async function setDate(user: ReturnType<typeof userEvent.setup>, field: "From" | "To", date: string) {
  await user.click(screen.getByRole("button", { name: new RegExp(`^${field},`) }));
  const dialog = screen.getByRole("dialog");
  const typed = within(dialog).getByRole("textbox");
  await user.clear(typed);
  await user.type(typed, date);
  await user.keyboard("{Escape}");
}

describe("RequestLeaveForm: preview", () => {
  test("asks for a preview of the pre-filled draft and shows its sentence, described by the submit button", async () => {
    renderForm();
    await waitFor(() => assert.equal(preview().textContent, "Takes 1 day of vacation."));

    assert.equal(previews.length, 1);
    assert.deepEqual(Object.fromEntries(previews[0]!.params), {
      leaveTypeId: "vacation",
      startDate: "2026-08-03",
      endDate: "2026-08-03",
      dayPortion: "full",
    });
    assert.equal(screen.getByRole("button", { name: "Request time off" }).getAttribute("aria-describedby"), "leave-preview");
  });

  test("a change asks again with the new draft", async () => {
    const user = userEvent.setup();
    renderForm();
    await waitFor(() => assert.equal(previews.length, 1));
    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "sick");

    await waitFor(() => assert.equal(preview().textContent, "Takes 1 day of sick."));
    assert.equal(previews.at(-1)!.params.get("leaveTypeId"), "sick");
  });

  test("an older answer never replaces a newer one: a new draft aborts the request before it", async () => {
    autoAnswer = null;
    const user = userEvent.setup();
    renderForm();
    await waitFor(() => assert.equal(previews.length, 1));
    const first = previews[0]!;
    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "sick");
    await waitFor(() => assert.equal(previews.length, 2));

    assert.equal(first.signal?.aborted, true);
    previews[1]!.settle({ ok: true, message: "Fresh answer." });
    await waitFor(() => assert.equal(preview().textContent, "Fresh answer."));
    first.settle({ ok: true, message: "Stale answer." });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(preview().textContent, "Fresh answer.");
  });

  test("quick changes ask once, for the draft they end on", async () => {
    const user = userEvent.setup();
    renderForm();
    await waitFor(() => assert.equal(previews.length, 1));
    const type = screen.getByRole("combobox", { name: "Type" });
    await user.selectOptions(type, "sick");
    await user.selectOptions(type, "vacation");
    await user.selectOptions(type, "sick");
    await waitFor(() => assert.equal(preview().textContent, "Takes 1 day of sick."));

    assert.equal(previews.length, 2);
  });

  test("while a newer preview is on its way, the last one stays, marked busy", async () => {
    autoAnswer = null;
    const user = userEvent.setup();
    renderForm();
    await waitFor(() => assert.equal(previews.length, 1));
    previews[0]!.settle({ ok: true, message: "Takes 1 day." });
    await waitFor(() => assert.equal(preview().textContent, "Takes 1 day."));
    assert.equal(preview().getAttribute("aria-busy"), "false");

    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "sick");
    assert.equal(preview().textContent, "Takes 1 day.");
    assert.equal(preview().getAttribute("aria-busy"), "true");
  });

  test("a refusal is shown as the preview", async () => {
    autoAnswer = () => ({ ok: false, message: "You'd need 2 more days of vacation." });
    renderForm();
    await waitFor(() => assert.equal(preview().textContent, "You'd need 2 more days of vacation."));
  });

  test("when the preview can't be reached, it says so", async () => {
    autoAnswer = null;
    renderForm();
    await waitFor(() => assert.equal(previews.length, 1));
    previews[0]!.fail();
    await waitFor(() => assert.equal(preview().textContent, "The preview isn't available right now."));
  });

  test("for someone else, the preview is for them", async () => {
    renderForm({ forPerson: { id: "user-ada", name: "Ada" } });
    await waitFor(() => assert.equal(previews.length, 1));

    assert.equal(previews[0]!.params.get("for"), "user-ada");
    assert.ok(screen.getByRole("heading", { name: "Add time off for Ada" }));
  });
});

describe("RequestLeaveForm: half days", () => {
  test("a single day offers the morning or the afternoon, and the preview follows", async () => {
    const user = userEvent.setup();
    renderForm();
    assert.equal(radio("Full day").checked, true);
    assert.equal(radio("Morning").disabled, false);
    await user.click(radio("Morning"));

    await waitFor(() => assert.equal(previews.at(-1)!.params.get("dayPortion"), "am"));
    await waitFor(() => assert.equal(preview().textContent, "Takes 0.5 days of vacation."));
  });

  test("more than one day turns half days off, back to Full day, and says why", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(radio("Afternoon"));
    await setDate(user, "To", "2026-08-05");

    assert.equal(radio("Full day").checked, true);
    assert.equal(radio("Morning").disabled, true);
    assert.equal(radio("Afternoon").disabled, true);
    assert.ok(screen.getByText("Half days are for a single date."));
    await waitFor(() => assert.deepEqual([previews.at(-1)!.params.get("endDate"), previews.at(-1)!.params.get("dayPortion")], ["2026-08-05", "full"]));
  });

  test("the end date follows the start until a later end is picked on purpose", async () => {
    const user = userEvent.setup();
    renderForm();
    await setDate(user, "From", "2026-08-10");
    assert.match(screen.getByRole("button", { name: /^To,/ }).getAttribute("aria-label")!, /August 10, 2026/);

    await setDate(user, "To", "2026-08-14");
    await setDate(user, "From", "2026-08-11");
    assert.match(screen.getByRole("button", { name: /^To,/ }).getAttribute("aria-label")!, /August 14, 2026/);
  });

  test("a start after the end moves the end with it, and a single day offers half days again", async () => {
    const user = userEvent.setup();
    renderForm();
    await setDate(user, "To", "2026-08-05");
    assert.equal(radio("Morning").disabled, true);
    await setDate(user, "From", "2026-08-07");

    assert.match(screen.getByRole("button", { name: /^To,/ }).getAttribute("aria-label")!, /August 7, 2026/);
    assert.equal(radio("Morning").disabled, false);
  });
});

describe("RequestLeaveForm: submit", () => {
  test("sends the draft, says how it went, and starts over with the preview hidden", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "sick");
    await user.click(radio("Morning"));
    await user.type(screen.getByRole("textbox", { name: /Note/ }), "Dentist");
    await user.click(screen.getByRole("button", { name: "Request time off" }));

    assert.deepEqual(submitted, [
      {
        action: "request",
        fields: { leaveTypeId: "sick", startDate: "2026-08-03", endDate: "2026-08-03", dayPortion: "am", note: "Dentist" },
      },
    ]);
    await waitFor(() => assert.ok(screen.getByText("Sent to your manager.")));
    assert.equal((screen.getByRole("combobox", { name: "Type" }) as HTMLSelectElement).value, "vacation");
    assert.equal((screen.getByRole("textbox", { name: /Note/ }) as HTMLTextAreaElement).value, "");
    assert.equal(radio("Full day").checked, true);
    assert.equal(preview().textContent, "");
  });

  test("a refused submit keeps what was typed and shows why", async () => {
    answer = () => ({ status: "error", message: "Those dates overlap another request.", fields: ["startDate"] });
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByRole("textbox", { name: /Note/ }), "Trip");
    await user.click(screen.getByRole("button", { name: "Request time off" }));

    await waitFor(() => assert.equal(screen.getByRole("alert").textContent, "Those dates overlap another request."));
    assert.equal((screen.getByRole("textbox", { name: /Note/ }) as HTMLTextAreaElement).value, "Trip");
  });

  test("for someone else it adds the time off for them", async () => {
    const user = userEvent.setup();
    renderForm({ forPerson: { id: "user-ada", name: "Ada" } });
    await user.click(screen.getByRole("button", { name: "Add time off" }));

    assert.equal(submitted[0]?.action, "addFor");
    assert.equal(submitted[0]?.fields.userId, "user-ada");
  });

  test("with approval off, it books rather than requests", () => {
    renderForm({ headsUp: true });
    assert.ok(screen.getByRole("button", { name: "Book time off" }));
    assert.ok(screen.getByText(/booked as you send it/));
  });
});
