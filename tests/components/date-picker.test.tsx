import { afterEach, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "./setup";
import { DatePicker } from "@/components/forms/date-picker";

// Today is Wednesday, Nov 18, 2026: local noon, so it is that date in whatever time zone the suite runs in.
beforeEach(() => mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 18, 12).getTime() }));
afterEach(() => mock.timers.reset());

function Picker({ initial = "2026-11-18", min, picked }: { initial?: string; min?: string; picked: string[] }) {
  const [value, setValue] = useState(initial);
  return (
    <form>
      <DatePicker
        name="startDate"
        label="From"
        pickerLabel="First day"
        value={value}
        min={min}
        onChange={(v) => {
          picked.push(v);
          setValue(v);
        }}
      />
      <button type="button">Elsewhere</button>
    </form>
  );
}

function renderPicker(props: { initial?: string; min?: string } = {}) {
  const picked: string[] = [];
  render(<Picker {...props} picked={picked} />);
  return { picked, trigger: screen.getByRole("button", { name: /^From,/ }) };
}

async function open(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement) {
  await user.click(trigger);
  return screen.getByRole("dialog", { name: "Choose first day" });
}

describe("DatePicker", () => {
  test("the trigger names the field and the date in words, and posts the value", () => {
    const { trigger } = renderPicker();
    assert.equal(trigger.getAttribute("aria-label"), "From, Wednesday, November 18, 2026");
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal((document.querySelector('input[name="startDate"]') as HTMLInputElement).value, "2026-11-18");
  });

  test("opening shows the month and moves focus to the chosen day", async () => {
    const user = userEvent.setup();
    const { trigger } = renderPicker({ initial: "2026-11-20" });
    const dialog = await open(user, trigger);

    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.ok(within(dialog).getByRole("grid", { name: "November 2026" }));
    const day = within(dialog).getByRole("gridcell", { name: "Friday, November 20, 2026" });
    assert.equal(document.activeElement, day);
    assert.equal(day.getAttribute("aria-selected"), "true");
    assert.ok(within(dialog).getByRole("gridcell", { name: "Wednesday, November 18, 2026, today" }));
  });

  test("arrow keys move through days and Enter picks one, closing the dialog onto the trigger", async () => {
    const user = userEvent.setup();
    const { trigger, picked } = renderPicker();
    await open(user, trigger);
    await user.keyboard("{ArrowRight}{ArrowDown}");

    assert.equal(document.activeElement?.getAttribute("aria-label"), "Thursday, November 26, 2026");
    await user.keyboard("{Enter}");
    assert.deepEqual(picked, ["2026-11-26"]);
    assert.equal(screen.queryByRole("dialog"), null);
    assert.equal(document.activeElement, trigger);
    assert.equal(trigger.getAttribute("aria-label"), "From, Thursday, November 26, 2026");
  });

  test("PageDown turns the month and keeps the day", async () => {
    const user = userEvent.setup();
    const { trigger } = renderPicker();
    const dialog = await open(user, trigger);
    await user.keyboard("{PageDown}");

    assert.ok(within(dialog).getByRole("grid", { name: "December 2026" }));
    assert.equal(document.activeElement?.getAttribute("aria-label"), "Friday, December 18, 2026");
  });

  test("Next month and Previous month turn the calendar", async () => {
    const user = userEvent.setup();
    const { trigger } = renderPicker();
    const dialog = await open(user, trigger);
    await user.click(within(dialog).getByRole("button", { name: "Next month" }));
    await user.click(within(dialog).getByRole("button", { name: "Next month" }));
    assert.ok(within(dialog).getByRole("grid", { name: "January 2027" }));

    await user.click(within(dialog).getByRole("button", { name: "Previous month" }));
    assert.ok(within(dialog).getByRole("grid", { name: "December 2026" }));
  });

  test("Escape closes without changing the date", async () => {
    const user = userEvent.setup();
    const { trigger, picked } = renderPicker();
    await open(user, trigger);
    await user.keyboard("{ArrowRight}{Escape}");

    assert.equal(screen.queryByRole("dialog"), null);
    assert.deepEqual(picked, []);
    assert.equal(document.activeElement, trigger);
  });

  test("a pointer press outside closes it, leaving the value as it was", async () => {
    const user = userEvent.setup();
    const { trigger, picked } = renderPicker();
    await open(user, trigger);
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));

    assert.equal(screen.queryByRole("dialog"), null);
    assert.deepEqual(picked, []);
  });

  test("a typed date is taken as soon as it is complete; a malformed one is explained", async () => {
    const user = userEvent.setup();
    const { trigger, picked } = renderPicker();
    const dialog = await open(user, trigger);
    const typed = within(dialog).getByRole("textbox", { name: "First day" });
    await user.clear(typed);
    await user.type(typed, "2026-12-0");

    assert.equal(typed.getAttribute("aria-invalid"), "true");
    assert.match(within(dialog).getByText(/Use YYYY-MM-DD/).textContent ?? "", /Use YYYY-MM-DD\./);
    await user.type(typed, "4");
    assert.deepEqual(picked, ["2026-12-04"]);
    assert.equal(typed.getAttribute("aria-invalid"), null);
    assert.ok(within(dialog).getByRole("grid", { name: "December 2026" }));
  });

  test("days before the minimum show but can't be picked, by click or by typing", async () => {
    const user = userEvent.setup();
    const { trigger, picked } = renderPicker({ initial: "2026-11-20", min: "2026-11-19" });
    const dialog = await open(user, trigger);
    const before = within(dialog).getByRole("gridcell", { name: "Tuesday, November 17, 2026" });
    assert.equal(before.getAttribute("aria-disabled"), "true");
    await user.click(before);
    assert.deepEqual(picked, []);
    assert.ok(screen.getByRole("dialog"));

    const typed = within(dialog).getByRole("textbox", { name: "First day" });
    await user.clear(typed);
    await user.type(typed, "2026-11-17");
    assert.deepEqual(picked, []);
    assert.match(within(dialog).getByText(/Use YYYY-MM-DD/).textContent ?? "", /on or after Thu, Nov 19/);
    // Today (Nov 18) is before the minimum too.
    assert.equal((within(dialog).getByRole("button", { name: /^Today/ }) as HTMLButtonElement).disabled, true);
  });

  test("Today picks today's date", async () => {
    const user = userEvent.setup();
    const { trigger, picked } = renderPicker({ initial: "2026-12-24" });
    const dialog = await open(user, trigger);
    await user.click(within(dialog).getByRole("button", { name: /^Today/ }));

    assert.deepEqual(picked, ["2026-11-18"]);
    assert.equal(screen.queryByRole("dialog"), null);
  });

  test("Tab stays inside the dialog: typed field, months, the grid's day, Today, and round again", async () => {
    const user = userEvent.setup();
    const { trigger } = renderPicker();
    const dialog = await open(user, trigger);
    const order: (string | null)[] = [];
    for (let i = 0; i < 5; i++) {
      await user.tab();
      const el = document.activeElement as HTMLElement;
      assert.ok(dialog.contains(el), "focus stays in the dialog");
      order.push(el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? el.textContent);
    }

    assert.deepEqual(order, ["Today · Wed, Nov 18", "YYYY-MM-DD", "Previous month", "Next month", "Wednesday, November 18, 2026, today"]);
  });

  test("a click on an open trigger closes it", async () => {
    const user = userEvent.setup();
    const { trigger } = renderPicker();
    await open(user, trigger);
    fireEvent.click(trigger);

    assert.equal(screen.queryByRole("dialog"), null);
  });
});
