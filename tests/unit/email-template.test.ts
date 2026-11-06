import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMAIL_MESSAGE_MAX,
  EMAIL_SUBJECT_MAX,
  fillTemplate,
  normalizeEmailCopy,
  templateVariables,
  unknownVariables,
} from "@/domain/email-template";
import { DomainError } from "@/domain/errors";

test("a template's variables are the names in double braces, spaces allowed inside", () => {
  assert.deepEqual(templateVariables("{{requester}} asked for {{ leave_type }}, {{dates}}."), ["requester", "leave_type", "dates"]);
  assert.deepEqual(templateVariables("No variables here {not one} {{}}"), []);
});

test("a variable sits on one line: a placeholder broken across lines is plain text, never half a variable", () => {
  assert.deepEqual(templateVariables("Hi {{requester\n\n}} and {{ dates\t}}"), ["dates"]);
  assert.deepEqual(templateVariables("{{\nrequester}}"), []);
});

test("unknown variables are named once each, in order", () => {
  assert.deepEqual(unknownVariables("Hi {{name}} {{requester}} {{name}} {{when}}", ["requester"]), ["name", "when"]);
  assert.deepEqual(unknownVariables("{{requester}}", ["requester"]), []);
});

test("filling swaps each variable for its value, and leaves other braces as typed", () => {
  const parts = fillTemplate("{{requester}} asked for {{ leave_type }} {not a variable}", { requester: "Ana", leave_type: "PTO" });
  assert.deepEqual(parts, [
    { text: "Ana", variable: "requester" },
    { text: " asked for " },
    { text: "PTO", variable: "leave_type" },
    { text: " {not a variable}" },
  ]);
});

test("a value is never read as a template, so typed braces in a name stay as they are", () => {
  const parts = fillTemplate("{{requester}} and {{dates}}", { requester: "{{dates}}", dates: "Nov 2" });
  assert.equal(parts.map((p) => p.text).join(""), "{{dates}} and Nov 2");
});

test("an unknown variable fills as nothing (saved copy is checked first; this is the last resort)", () => {
  assert.equal(fillTemplate("Hi {{who}}!", {}).map((p) => p.text).join(""), "Hi !");
});

test("copy is normalized: trimmed, a one-line subject, paragraphs kept, blank means the default", () => {
  const allowed = { subject: ["requester"], message: ["requester", "dates"] };
  assert.deepEqual(normalizeEmailCopy({ subject: "  Leave from\r\n{{requester}}  ", message: " Hello\r\n\r\n\r\nThere {{dates}} \n" }, allowed), {
    subject: "Leave from {{requester}}",
    message: "Hello\n\nThere {{dates}}",
  });
  assert.deepEqual(normalizeEmailCopy({ subject: "   ", message: "" }, allowed), { subject: null, message: null });
});

test("copy that names a variable the email does not have, or is too long, is refused", () => {
  const allowed = { subject: ["requester"], message: ["requester", "dates"] };
  const refused = (copy: { subject: string; message: string }, field: string) =>
    assert.throws(
      () => normalizeEmailCopy(copy, allowed),
      (err: unknown) => err instanceof DomainError && err.code === "invalid_input" && (err.details as { field?: string } | undefined)?.field === field,
    );
  refused({ subject: "{{dates}}", message: "" }, "subject");
  refused({ subject: "", message: "{{note}}" }, "message");
  refused({ subject: "x".repeat(EMAIL_SUBJECT_MAX + 1), message: "" }, "subject");
  refused({ subject: "", message: "x".repeat(EMAIL_MESSAGE_MAX + 1) }, "message");
});
