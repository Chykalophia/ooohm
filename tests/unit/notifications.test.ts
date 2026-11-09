import assert from "node:assert/strict";
import { test } from "node:test";
import type { MailMessage, ServiceContext } from "@/server/context";
import { NOTIFICATION_TYPES, type Notification } from "@/server/notifications/catalog";
import { renderInviteEmail } from "@/server/notifications/templates/invite";
import { type LeaveSummary, renderLeaveEmail } from "@/server/notifications/templates/leave";
import { commitThenNotify } from "@/server/services/notify";

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

const approved = (to: string, requestId = "req-1"): Notification => ({
  type: "leave.approved",
  to,
  data: { requestId, recipientName: "Ana", leave: leave(), reason: null, link: "https://x/" },
});

const invite = (to: string, userId = "u-1"): Notification => ({
  type: "invite",
  to,
  data: { userId, recipientName: "Ana", inviterName: "Peter", companyName: "Acme", signInUrl: "https://x/sign-in" },
});

/** Captures the JSON log lines written while `run` runs. */
async function captureLog(run: () => Promise<void>): Promise<Record<string, unknown>[]> {
  const stderr = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  process.stderr.write = ((chunk: string) => (lines.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = stderr;
  }
  return lines.flatMap((l) => l.split("\n")).filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * A context whose transaction commits at once (or fails, after `work`), with no company
 * to read (so emails take the default accent), recording what runs when.
 */
function fakeContext(
  options: {
    mailer?: (m: MailMessage) => Promise<void>;
    issueSignInLink?: (email: string) => Promise<string>;
    commit?: "ok" | "fails";
  } = {},
) {
  const timeline: string[] = [];
  const sent: MailMessage[] = [];
  const tasks: Promise<void>[] = [];
  const ctx = {
    mailer:
      options.mailer ??
      (async (m: MailMessage) => {
        timeline.push(`send ${m.to}`);
        sent.push(m);
      }),
    issueSignInLink:
      options.issueSignInLink ??
      (async (email: string) => {
        timeline.push(`link ${email}`);
        return `https://x/verify?for=${encodeURIComponent(email)}`;
      }),
    defer: (task: () => Promise<void>) => {
      timeline.push("deferred");
      tasks.push(task());
    },
    db: {
      // No company to read: every query finds nothing.
      select: () => ({ from: () => ({ where: async () => [] }) }),
      transaction: async (work: (tx: unknown) => Promise<unknown>) => {
        const value = await work({});
        timeline.push(options.commit === "fails" ? "rolled back" : "committed");
        if (options.commit === "fails") throw new Error("could not serialize access");
        return value;
      },
    },
  } as unknown as ServiceContext;
  return { ctx, timeline, sent, settle: () => Promise.all(tasks) };
}

test("the catalog names every email the app sends", () => {
  assert.deepEqual(Object.keys(NOTIFICATION_TYPES).sort(), [
    "invite",
    "leave.added",
    "leave.approved",
    "leave.booked",
    "leave.cancelled_approver",
    "leave.cancelled_requester",
    "leave.heads_up",
    "leave.recounted",
    "leave.rejected",
    "leave.removed",
    "leave.requested",
  ]);
});

test("a notification is sent as its template renders it, to its recipient", async () => {
  const { ctx, sent, settle } = fakeContext();
  await commitThenNotify(ctx, "c1", async () => ({ result: null, notify: [approved("ana@example.com")] }));
  await settle();
  const expected = renderLeaveEmail({ kind: "approved", recipientName: "Ana", leave: leave(), reason: null, link: "https://x/" });
  assert.deepEqual(sent, [{ to: "ana@example.com", ...expected }]);
});

test("commitThenNotify returns the work's result and queues nothing while the transaction is open", async () => {
  const { ctx, timeline, settle } = fakeContext();
  const result = await commitThenNotify(ctx, "c1", async () => {
    timeline.push("work");
    return { result: { id: "req-1" }, notify: [approved("a@example.com")] };
  });
  await settle();
  assert.deepEqual(result, { id: "req-1" });
  assert.deepEqual(timeline, ["work", "committed", "deferred", "send a@example.com"]);
});

test("a transaction that fails to commit sends nothing", async () => {
  const { ctx, timeline, settle } = fakeContext({ commit: "fails" });
  await assert.rejects(commitThenNotify(ctx, "c1", async () => ({ result: null, notify: [approved("a@example.com")] })));
  await settle();
  assert.deepEqual(timeline, ["rolled back"]);
});

test("nothing is scheduled when there is nothing to send", async () => {
  const { ctx, timeline } = fakeContext();
  await commitThenNotify(ctx, "c1", async () => ({ result: null, notify: [] }));
  assert.deepEqual(timeline, ["committed"]);
});

/** Shaped like nodemailer's rejection: the SMTP reply quotes the address. */
function smtpRejection(address: string) {
  return Object.assign(
    new Error(`Can't send mail - all recipients were rejected: 550 5.1.1 <${address}>: Recipient address rejected`),
    { code: "EENVELOPE", responseCode: 550, command: "RCPT TO", response: `550 5.1.1 <${address}>: Recipient address rejected` },
  );
}

test("a failed send is logged with its type's fields, never the address, and the rest still go out", async () => {
  const delivered: string[] = [];
  const { ctx, settle } = fakeContext({
    mailer: async (m) => {
      if (m.to === "down@example.com") throw smtpRejection(m.to);
      delivered.push(m.to);
    },
  });
  const logged = await captureLog(async () => {
    await commitThenNotify(ctx, "c1", async () => ({
      result: null,
      notify: [approved("down@example.com", "req-9"), approved("up@example.com")],
    }));
    await settle();
  });

  assert.deepEqual(delivered, ["up@example.com"]);
  const line = logged.find((l) => l.event === "leave_email_failed");
  assert.ok(line, "the failure is logged");
  assert.equal(line.requestId, "req-9");
  assert.equal(line.kind, "approved", "the leave kind, as before");
  const err = line.err as Record<string, unknown>;
  assert.deepEqual([err.code, err.responseCode, err.command], ["EENVELOPE", 550, "RCPT TO"], "enough to diagnose the failure");
  assert.doesNotMatch(JSON.stringify(line), /down@example\.com/);
});

test("an invite's sign-in link is issued at send time, after commit, for the recipient", async () => {
  const { ctx, timeline, sent, settle } = fakeContext();
  await commitThenNotify(ctx, "c1", async () => {
    timeline.push("work");
    return { result: null, notify: [invite("ana@example.com")] };
  });
  await settle();
  assert.deepEqual(timeline, ["work", "committed", "deferred", "link ana@example.com", "send ana@example.com"]);
  const expected = renderInviteEmail({
    recipientName: "Ana",
    inviterName: "Peter",
    companyName: "Acme",
    link: "https://x/verify?for=ana%40example.com",
    signInUrl: "https://x/sign-in",
  });
  assert.deepEqual(sent, [{ to: "ana@example.com", ...expected }]);
});

test("an invite whose link cannot be issued is logged with the person's id, and the rest still go out", async () => {
  const { ctx, sent, settle } = fakeContext({
    issueSignInLink: async (email) => {
      if (email === "gone@example.com") throw new Error("no such account");
      return "https://x/verify";
    },
  });
  const logged = await captureLog(async () => {
    await commitThenNotify(ctx, "c1", async () => ({ result: null, notify: [invite("gone@example.com", "u-7"), invite("ana@example.com")] }));
    await settle();
  });
  assert.deepEqual(sent.map((m) => m.to), ["ana@example.com"]);
  const line = logged.find((l) => l.event === "invite_email_failed");
  assert.equal(line?.userId, "u-7");
  assert.doesNotMatch(JSON.stringify(logged), /gone@example\.com/);
});
