import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FormState } from "@/components/forms/form-state";
import type { PreviewState } from "@/app/admin/emails/actions";
import { stubModule } from "./setup";

type Draft = { type: string; subject: string; message: string };
const previewed: Draft[] = [];
const saved: Record<string, FormDataEntryValue>[] = [];
let previewAnswer: (draft: Draft) => PreviewState;
stubModule("@/app/admin/emails/actions", {
  previewEmailAction: async (draft: Draft): Promise<PreviewState> => {
    previewed.push(draft);
    return previewAnswer(draft);
  },
  saveEmailCopyAction: async (_prev: FormState, formData: FormData): Promise<FormState> => {
    saved.push(Object.fromEntries(formData));
    return { status: "success", message: "Saved.", id: "s1" };
  },
  resetEmailCopyAction: async (): Promise<FormState> => ({ status: "idle" }),
});

let EmailEditor: typeof import("@/app/admin/emails/[type]/email-editor").EmailEditor;
before(async () => ({ EmailEditor } = await import("@/app/admin/emails/[type]/email-editor")));

beforeEach(() => {
  previewed.length = 0;
  saved.length = 0;
  previewAnswer = (d) => ({ status: "preview", subject: `Preview: ${d.subject}`, html: `<p>${d.message}</p>` });
});

const variables = [
  { name: "name", description: "The requester's name" },
  { name: "dates", description: "The request's dates" },
];
const initial = { subject: "Time off for {{name}}", message: "Hello" };

function renderEditor(props: Partial<Parameters<typeof EmailEditor>[0]> = {}) {
  return render(
    <EmailEditor
      type="leave_approved"
      initial={initial}
      variables={variables}
      firstPreview={{ subject: "Time off for Ada", html: "<p>Hello</p>" }}
      {...props}
    />,
  );
}

const subject = () => screen.getByRole("textbox", { name: "Subject" }) as HTMLInputElement;
const message = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const previewRegion = () => screen.getByRole("region", { name: "Preview" });
const frame = () => screen.getByTitle("Email preview") as HTMLIFrameElement;
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe("EmailEditor", () => {
  test("shows the saved wording and the first preview, without asking the server", async () => {
    renderEditor();
    assert.equal(subject().value, "Time off for {{name}}");
    assert.equal(message().value, "Hello");
    assert.match(previewRegion().textContent ?? "", /Subject: Time off for Ada/);
    assert.equal(frame().getAttribute("srcdoc"), "<p>Hello</p>");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(previewed, []);
  });

  test("each variable is a button that names it and says what it fills in", () => {
    renderEditor();
    assert.ok(screen.getByRole("button", { name: "Add {{name}}: The requester's name" }));
    assert.ok(screen.getByRole("button", { name: "Add {{dates}}: The request's dates" }));
  });

  test("a variable goes where the cursor was, and focus returns there after it", async () => {
    const user = userEvent.setup();
    renderEditor();
    const field = subject();
    field.focus();
    field.setSelectionRange(4, 4);
    fireEvent.select(field);
    await user.click(screen.getByRole("button", { name: /^Add \{\{dates\}\}/ }));
    await nextFrame();

    assert.equal(field.value, "Time{{dates}} off for {{name}}");
    assert.equal(document.activeElement, field);
    assert.equal(field.selectionStart, "Time{{dates}}".length);
  });

  test("with no cursor placed yet, a variable goes at the end of the message", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByRole("button", { name: /^Add \{\{name\}\}/ }));

    assert.equal(message().value, "Hello{{name}}");
  });

  test("typing updates the preview after a pause", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.clear(subject());
    await user.type(subject(), "Approved");

    await waitFor(() => assert.match(previewRegion().textContent ?? "", /Subject: Preview: Approved/));
    assert.equal(frame().getAttribute("srcdoc"), "<p>Hello</p>");
    assert.deepEqual(previewed.at(-1), { type: "leave_approved", subject: "Approved", message: "Hello" });
    assert.ok(previewed.length < "Approved".length, "the preview waits for typing to pause");
  });

  test("a variable the email doesn't have is named at once", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.type(message(), " {{{{manager}}");

    assert.equal(
      within(previewRegion()).getByRole("alert").textContent,
      "This email has no {{manager}}. Use one of the variables listed.",
    );
  });

  test("a draft the server refuses keeps the last good preview and says why", async () => {
    previewAnswer = () => ({ status: "error", message: "Keep the subject under 150 characters." });
    const user = userEvent.setup();
    renderEditor();
    await user.type(subject(), "!");

    await waitFor(() => assert.equal(within(previewRegion()).getByRole("alert").textContent, "Keep the subject under 150 characters."));
    assert.match(previewRegion().textContent ?? "", /Subject: Time off for Ada/);
  });

  test("when the preview can't be reached, the wording stays and it says so", async () => {
    previewAnswer = () => {
      throw new Error("network");
    };
    const user = userEvent.setup();
    renderEditor();
    await user.type(message(), "!");

    await waitFor(() =>
      assert.equal(within(previewRegion()).getByRole("alert").textContent, "The preview isn't available right now. Your wording is unchanged."),
    );
    assert.equal(message().value, "Hello!");
  });

  test("Save wording sends the type and both fields", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.type(message(), " there");
    await user.click(screen.getByRole("button", { name: "Save wording" }));

    assert.deepEqual(saved, [{ type: "leave_approved", subject: "Time off for {{name}}", message: "Hello there" }]);
    assert.ok(await screen.findByText("Saved."));
  });

  test("new saved wording from the page replaces the draft", async () => {
    const user = userEvent.setup();
    const view = renderEditor();
    await user.type(message(), " draft");
    view.rerender(
      <EmailEditor
        type="leave_approved"
        initial={{ subject: "", message: "" }}
        variables={variables}
        firstPreview={{ subject: "Time off for Ada", html: "<p>Hello</p>" }}
      />,
    );

    assert.equal(subject().value, "");
    assert.equal(message().value, "");
  });
});
