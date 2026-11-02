import assert from "node:assert/strict";
import { test } from "node:test";
import { DrizzleQueryError } from "drizzle-orm";
import { log } from "@/lib/log";

function captureStderr(fn: () => void): Record<string, unknown> {
  const stderr = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  process.stderr.write = ((chunk: string) => (lines.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = stderr;
  }
  assert.equal(lines.length, 1);
  return JSON.parse(lines[0]);
}

test("a failed query is logged with its SQL and driver error, never its parameters", () => {
  const secret = "Chemo appointment, back Thursday";
  const cause = Object.assign(new Error('new row for relation "leave_requests" violates check constraint "x"'), {
    name: "PostgresError",
    code: "23514",
  });
  const err = new DrizzleQueryError('insert into "leave_requests" ("note") values ($1)', [secret], cause);
  assert.match(err.message, /Chemo/, "drizzle itself puts parameters in the message");

  const line = captureStderr(() => log.error({ err }, "leave_request_submit_failed"));
  assert.doesNotMatch(JSON.stringify(line), /Chemo/);
  assert.deepEqual(line.err, {
    name: "DrizzleQueryError",
    query: 'insert into "leave_requests" ("note") values ($1)',
    cause: { name: "PostgresError", code: "23514", message: 'new row for relation "leave_requests" violates check constraint "x"' },
  });
});

test("an SMTP failure is logged by its codes, never the reply that quotes the address", () => {
  const err = Object.assign(new Error("Can't send mail - all recipients were rejected: 550 <ana@example.com>: no such user"), {
    code: "EENVELOPE",
    responseCode: 550,
    command: "RCPT TO",
    response: "550 <ana@example.com>: no such user",
  });
  const line = captureStderr(() => log.error({ err }, "leave_email_failed"));
  assert.doesNotMatch(JSON.stringify(line), /ana@example\.com/);
  assert.deepEqual(line.err, { name: "Error", code: "EENVELOPE", responseCode: 550, command: "RCPT TO" });
});

test("any other error keeps its message and stack", () => {
  const line = captureStderr(() => log.error({ err: new TypeError("boom") }, "x_failed"));
  const err = line.err as { name: string; message: string; stack: string };
  assert.equal(err.name, "TypeError");
  assert.equal(err.message, "boom");
  assert.match(err.stack, /TypeError: boom/);
});
