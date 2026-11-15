import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
// Type-only imports are erased, so they load neither module before the stub is in place.
import type { DeleteState } from "@/app/admin/people/actions";
import type { DeletePersonDialogProps } from "@/app/admin/people/delete-person-dialog";
import { stubModule } from "./setup";

const sent: Record<string, FormDataEntryValue>[] = [];
let answer: () => DeleteState;
const unused = async () => ({ status: "idle" as const });
stubModule("@/app/admin/people/actions", {
  deletePersonAction: async (_prev: DeleteState, formData: FormData): Promise<DeleteState> => {
    sent.push(Object.fromEntries(formData));
    return answer();
  },
  inviteAction: unused,
  updatePersonAction: unused,
  resendInviteAction: unused,
  deactivateAction: unused,
  reactivateAction: unused,
  cancelDeletionAction: unused,
  allowanceAction: unused,
});

let DeletePersonDialog: typeof import("@/app/admin/people/delete-person-dialog").DeletePersonDialog;
before(async () => ({ DeletePersonDialog } = await import("@/app/admin/people/delete-person-dialog")));

beforeEach(() => {
  sent.length = 0;
  answer = () => ({ status: "error", message: "Something changed; try again." });
});

const noBlockers = { stillActive: false, reports: [], pendingApprovals: 0, lastAdmin: false };
const baseProps: DeletePersonDialogProps = {
  personId: "user-ada",
  confirmName: "Ada Lovelace",
  blockers: noBlockers,
  blocked: false,
  describe: {
    scrubbed: { removes: ["Their account", "12 leave requests"], keeps: [] },
    records_kept: { removes: ["Their sign-in"], keeps: ["12 leave requests", "Their audit entries"] },
  },
  deletionGrace: false,
  graceDays: 7,
  scrubScheduledFor: null,
  exportHref: "/admin/people/user-ada/export",
};

async function openDialog(props: Partial<DeletePersonDialogProps> = {}) {
  const user = userEvent.setup();
  render(<DeletePersonDialog {...baseProps} {...props} />);
  await user.click(screen.getByRole("button", { name: "Delete…" }));
  return { user, dialog: screen.getByRole("dialog", { name: `Delete ${props.confirmName ?? baseProps.confirmName}?` }) };
}

const listed = (dialog: HTMLElement, heading: string) =>
  within(within(dialog).getByText(heading).nextElementSibling as HTMLElement)
    .getAllByRole("listitem")
    .map((li) => li.textContent);

describe("DeletePersonDialog", () => {
  test("opens on Delete… with a full scrub chosen and what it removes", async () => {
    const { dialog } = await openDialog();

    assert.equal((within(dialog).getByRole("radio", { name: /Remove everything/ }) as HTMLInputElement).checked, true);
    assert.deepEqual(listed(dialog, "This removes:"), ["Their account", "12 leave requests"]);
    assert.equal(within(dialog).queryByText("This keeps:"), null);
    assert.equal(within(dialog).getByRole("link", { name: "Download their records first" }).getAttribute("href"), "/admin/people/user-ada/export");
  });

  test("choosing to keep records says what goes and what stays", async () => {
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole("radio", { name: /keep their records/ }));

    assert.deepEqual(listed(dialog, "This removes:"), ["Their sign-in"]);
    assert.deepEqual(listed(dialog, "This keeps:"), ["12 leave requests", "Their audit entries"]);
  });

  test("the delete button stays off until the person's name is typed", async () => {
    const { user, dialog } = await openDialog();
    const confirm = within(dialog).getByRole("textbox", { name: "Type Ada Lovelace to confirm" });
    const button = within(dialog).getByRole("button", { name: "Delete permanently" }) as HTMLButtonElement;
    assert.equal(button.disabled, true);

    await user.type(confirm, "Ada");
    assert.equal(button.disabled, true);
    await user.type(confirm, " lovelace");
    assert.equal(button.disabled, false);
  });

  test("deleting sends the person, the mode and the typed name; a refusal is announced and focused", async () => {
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole("radio", { name: /keep their records/ }));
    await user.type(within(dialog).getByRole("textbox", { name: /to confirm/ }), "Ada Lovelace");
    await user.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    assert.deepEqual(sent, [{ userId: "user-ada", mode: "records_kept", confirmName: "Ada Lovelace" }]);
    const alert = await within(dialog).findByRole("alert");
    assert.equal(alert.textContent, "Something changed; try again.");
    await waitFor(() => assert.equal(document.activeElement, alert));
  });

  test("with the grace option on, a full scrub is scheduled and the button says when", async () => {
    const { dialog } = await openDialog({ deletionGrace: true });

    assert.ok(within(dialog).getByText(/It runs in 7 days; you can undo it until then\./));
    assert.ok(within(dialog).getByRole("button", { name: "Delete in 7 days" }));
    assert.match(dialog.textContent ?? "", /This can't be undone once it runs\./);
  });

  test("with a scrub already scheduled, only keeping records is left to choose", async () => {
    const { dialog } = await openDialog({ deletionGrace: true, scrubScheduledFor: "Nov 22, 2026" });
    const scrub = within(dialog).getByRole("radio", { name: /Remove everything/ }) as HTMLInputElement;

    assert.equal(scrub.disabled, true);
    assert.equal((within(dialog).getByRole("radio", { name: /keep their records/ }) as HTMLInputElement).checked, true);
    assert.ok(within(dialog).getByText(/Already scheduled for Nov 22, 2026/));
    assert.ok(within(dialog).getByRole("button", { name: "Delete permanently" }));
  });

  test("when something blocks the delete, it lists what to sort out instead of the form", async () => {
    const { user, dialog } = await openDialog({
      blocked: true,
      blockers: { stillActive: true, reports: [{ id: "user-bob", name: "Bob" }], pendingApprovals: 2, lastAdmin: false },
    });

    assert.equal(within(dialog).queryByRole("textbox"), null);
    assert.ok(within(dialog).getByText(/Deactivate them first/));
    assert.equal(within(dialog).getByRole("link", { name: "Bob" }).getAttribute("href"), "/admin/people/user-bob");
    assert.ok(within(dialog).getByText(/2 requests are waiting for their decision/));
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    assert.equal(screen.queryByRole("dialog"), null);
  });

  test("a delete refused because something now blocks it shows the current blockers", async () => {
    answer = () => ({ status: "blocked", blockers: { ...noBlockers, lastAdmin: true } });
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByRole("textbox", { name: /to confirm/ }), "Ada Lovelace");
    await user.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    assert.ok(await within(dialog).findByText(/They're the only admin/));
    assert.equal(within(dialog).queryByRole("button", { name: "Delete permanently" }), null);
  });

  test("Cancel closes the dialog without sending anything", async () => {
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    assert.equal(screen.queryByRole("dialog"), null);
    assert.deepEqual(sent, []);
  });
});
