import assert from "node:assert/strict";
import { test } from "node:test";
import { type LeaveEmail, type LeaveSummary, personLabel, renderLeaveEmail } from "@/server/email/leave-emails";
import type { MailMessage, ServiceContext } from "@/server/context";
import { commitThenNotify } from "@/server/services/notify";

const hostile = 'Eve <script>alert("x")</script>\r\nBcc: victim@example.com';

const leave = (over: Partial<LeaveSummary> = {}): LeaveSummary => ({
  requesterName: "Ana",
  leaveTypeName: "PTO",
  startDate: "2026-11-02",
  endDate: "2026-11-06",
  dayPortion: "full",
  days: 5,
  note: null,
  ...over,
});

const kinds: LeaveEmail[] = [
  { kind: "requested", recipientName: hostile, leave: leave({ requesterName: hostile, note: hostile }), link: "https://x/approvals" },
  { kind: "approved", recipientName: hostile, leave: leave({ requesterName: hostile }), reason: hostile, link: "https://x/" },
  { kind: "rejected", recipientName: hostile, leave: leave({ requesterName: hostile }), reason: hostile, link: "https://x/" },
  { kind: "cancelled_requester", recipientName: hostile, leave: leave({ requesterName: hostile }), link: "https://x/" },
  { kind: "cancelled_approver", recipientName: hostile, leave: leave({ requesterName: hostile }), link: "https://x/approvals" },
];

test("subjects are fixed strings that never carry user input", () => {
  const subjects = kinds.map((k) => renderLeaveEmail(k).subject);
  assert.deepEqual(subjects, [
    "Time off request to review",
    "Your time off is approved",
    "Your time off request was declined",
    "Your time off request was cancelled",
    "A time off request was cancelled",
  ]);
  for (const s of subjects) assert.doesNotMatch(s, /[\r\n]/);
});

test("user text is escaped in HTML and kept verbatim in plain text", () => {
  for (const k of kinds) {
    const { html, text } = renderLeaveEmail(k);
    assert.doesNotMatch(html, /<script>/, k.kind);
    assert.match(html, /&lt;script&gt;/, k.kind);
    assert.match(text, /Hi Eve <script>/, k.kind);
  }
});

test("the approver sees the note; a declined requester sees the reason", () => {
  const requested = renderLeaveEmail({ kind: "requested", recipientName: "Sam", leave: leave({ note: "Family wedding" }), link: "https://x/approvals" });
  assert.match(requested.text, /Ana asked for time off\./);
  assert.match(requested.text, /Note: Family wedding/);
  assert.match(requested.text, /Dates: Mon, Nov 2 to Fri, Nov 6, 2026/);
  assert.match(requested.text, /Days: 5 days/);
  assert.match(requested.text, /https:\/\/x\/approvals/);

  const rejected = renderLeaveEmail({ kind: "rejected", recipientName: "Ana", leave: leave(), reason: "Launch week", link: "https://x/" });
  assert.match(rejected.text, /Reason: Launch week/);
  const rejectedNoReason = renderLeaveEmail({ kind: "rejected", recipientName: "Ana", leave: leave(), reason: null, link: "https://x/" });
  assert.doesNotMatch(rejectedNoReason.text, /Reason:/);
});

test("an approved requester sees the approver's note, when there is one", () => {
  const withNote = renderLeaveEmail({ kind: "approved", recipientName: "Ana", leave: leave(), reason: "Hand over X first", link: "https://x/" });
  assert.match(withNote.text, /Note from approver: Hand over X first/);
  assert.match(withNote.html, /Note from approver/);
  const without = renderLeaveEmail({ kind: "approved", recipientName: "Ana", leave: leave(), reason: null, link: "https://x/" });
  assert.doesNotMatch(without.text, /Note from approver/);
});

test("names are one capped line, so a name cannot add paragraphs to someone else's email", () => {
  const forged = "Bob.\n\nYour OOOhm session expired. Re-verify at https://evil.example\n\n";
  const { text } = renderLeaveEmail({
    kind: "requested",
    recipientName: "  Sam\r\n ",
    leave: leave({ requesterName: forged }),
    link: "https://x/approvals",
  });
  assert.match(text, /^Hi Sam,\n/);
  assert.match(text, /^Bob\. Your OOOhm session expired\. Re-verify at https:\/\/evil\.example asked for time off\.$/m);
  assert.equal(text.split("\n").filter((l) => l.includes("evil.example")).length, 1);

  const long = renderLeaveEmail({ kind: "requested", recipientName: "Sam", leave: leave({ requesterName: "A".repeat(500) }), link: "https://x/" });
  assert.match(long.text, new RegExp(`^${"A".repeat(100)} asked for time off\\.$`, "m"));
});

test("someone without a name is named by their email address, as the inbox shows them", () => {
  const person = (name: string) => ({ name, email: "ana@example.com" });
  assert.equal(personLabel(person("Ana Lima")), "Ana Lima");
  assert.equal(personLabel(person("")), "ana@example.com");
  assert.equal(personLabel(person(" \n\t ")), "ana@example.com");

  for (const kind of ["requested", "cancelled_approver"] as const) {
    const { text } = renderLeaveEmail({
      kind,
      recipientName: "Sam",
      leave: leave({ requesterName: personLabel(person("  ")) }),
      link: "https://x/approvals",
    });
    assert.match(text, /^ana@example\.com (asked for|cancelled their) time off\./m, kind);
  }
});

test("half days say which half", () => {
  const { text } = renderLeaveEmail({
    kind: "approved",
    reason: null,
    recipientName: "Ana",
    leave: leave({ startDate: "2026-11-02", endDate: "2026-11-02", dayPortion: "pm", days: 0.5 }),
    link: "https://x/",
  });
  assert.match(text, /Dates: Mon, Nov 2, 2026 \(afternoon\)/);
  assert.match(text, /Days: 0\.5 days/);
});

/** A context whose transaction commits at once; `defer` runs tasks into `tasks`. */
function committingContext(mailer: (m: MailMessage) => Promise<void>, tasks: Promise<void>[]) {
  return {
    mailer,
    defer: (task: () => Promise<void>) => tasks.push(task()),
    db: { transaction: async (work: (tx: unknown) => Promise<unknown>) => work({}) },
  } as unknown as ServiceContext;
}

/** Shaped like nodemailer's rejection: the SMTP reply quotes the address. */
function smtpRejection(address: string) {
  return Object.assign(
    new Error(`Can't send mail - all recipients were rejected: 550 5.1.1 <${address}>: Recipient address rejected`),
    { code: "EENVELOPE", responseCode: 550, command: "RCPT TO", response: `550 5.1.1 <${address}>: Recipient address rejected` },
  );
}

test("a failed send is logged without the address and does not stop the remaining emails or throw", async () => {
  const delivered: MailMessage[] = [];
  const tasks: Promise<void>[] = [];
  const ctx = committingContext(async (m) => {
    if (m.to === "down@example.com") throw smtpRejection(m.to);
    delivered.push(m);
  }, tasks);

  const stderr = process.stderr.write.bind(process.stderr);
  const logged: string[] = [];
  process.stderr.write = ((chunk: string) => (logged.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    const result = await commitThenNotify(ctx, async () => ({
      result: { id: "req-1" },
      outgoing: [
        { to: "down@example.com", email: kinds[1] },
        { to: "up@example.com", email: kinds[1] },
      ],
    }));
    assert.deepEqual(result, { id: "req-1" });
    await Promise.all(tasks);
  } finally {
    process.stderr.write = stderr;
  }

  assert.deepEqual(delivered.map((m) => m.to), ["up@example.com"]);
  const line = JSON.parse(logged.find((l) => l.includes("leave_email_failed")) ?? "{}");
  assert.equal(line.event, "leave_email_failed");
  assert.equal(line.requestId, "req-1");
  assert.deepEqual(
    [line.err.code, line.err.responseCode, line.err.command],
    ["EENVELOPE", 550, "RCPT TO"],
    "enough to diagnose the failure",
  );
  assert.doesNotMatch(JSON.stringify(line), /down@example\.com/);
});

test("nothing is scheduled when there is nothing to send", async () => {
  const tasks: Promise<void>[] = [];
  await commitThenNotify(committingContext(async () => {}, tasks), async () => ({ result: { id: "req-1" }, outgoing: [] }));
  assert.equal(tasks.length, 0);
});

test("emails are queued only once the transaction has committed", async () => {
  const outgoing = [{ to: "a@example.com", email: kinds[1] }];
  let deferred = 0;
  const ctxWith = (commit: "ok" | "fails") =>
    ({
      defer: () => deferred++,
      db: {
        transaction: async (work: (tx: unknown) => Promise<unknown>) => {
          const value = await work({});
          assert.equal(deferred, 0, "nothing is queued while the transaction is open");
          if (commit === "fails") throw new Error("could not serialize access");
          return value;
        },
      },
    }) as unknown as ServiceContext;

  await assert.rejects(commitThenNotify(ctxWith("fails"), async () => ({ result: { id: "r1" }, outgoing })));
  assert.equal(deferred, 0, "a failed commit sends nothing");

  const result = await commitThenNotify(ctxWith("ok"), async () => ({ result: { id: "r2" }, outgoing }));
  assert.deepEqual(result, { id: "r2" });
  assert.equal(deferred, 1);
});
