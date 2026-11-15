import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { NOTIFICATION_TYPES } from "@/modules/notifications/application/catalog";
import { toEmailEditorDTO, toEmailListItemDTO, toEmailPreviewDTO } from "@/modules/notifications/application/dto";

/** The Admin → Emails screens read these DTOs and nothing else; these pin their fields. */

describe("toEmailListItemDTO", () => {
  test("is the type, its label and description, and whether the company has its own words", () => {
    const item = { type: "leave.approved" as const, label: "Approved", description: "To the requester.", customized: true, updatedAt: new Date() };
    assert.deepEqual(toEmailListItemDTO(item), { type: "leave.approved", label: "Approved", description: "To the requester.", customized: true });
  });
});

describe("toEmailEditorDTO", () => {
  const { copy } = NOTIFICATION_TYPES["leave.requested"];
  const dto = toEmailEditorDTO({
    type: "leave.requested",
    label: copy.label,
    description: copy.description,
    variables: copy.variables.map((v) => ({ ...v, internal: true })),
    defaults: { ...copy.defaults, extra: "x" } as typeof copy.defaults,
    saved: { subject: "Hi {{requester}}", message: null },
  });

  test("returns exactly the fields the editor shows", () => {
    assert.deepEqual(Object.keys(dto).sort(), ["defaults", "description", "label", "saved", "type", "variables"]);
    assert.deepEqual(Object.keys(dto.defaults).sort(), ["message", "subject"]);
    assert.deepEqual(dto.saved, { subject: "Hi {{requester}}", message: null });
  });

  test("lists each variable by its name and what it fills in", () => {
    assert.ok(dto.variables.length > 0);
    for (const v of dto.variables) assert.deepEqual(Object.keys(v).sort(), ["description", "name"]);
    assert.deepEqual(
      dto.variables.map((v) => v.name),
      copy.variables.map((v) => v.name),
    );
  });

  test("an email on its defaults has no saved words", () => {
    assert.equal(toEmailEditorDTO({ ...dto, saved: null }).saved, null);
  });
});

describe("toEmailPreviewDTO", () => {
  test("is the subject, the plain text and the HTML", () => {
    const preview = { subject: "S", text: "T", html: "<p>H</p>", headers: { x: "y" } };
    assert.deepEqual(toEmailPreviewDTO(preview), { subject: "S", text: "T", html: "<p>H</p>" });
  });
});
