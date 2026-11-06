import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_EMAIL_ACCENT, emailAccent, type LeaveEmail, type LeaveSummary, personLabel, renderLeaveEmail } from "@/server/email/leave-emails";
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
  { kind: "added", recipientName: hostile, leave: leave({ requesterName: hostile, note: hostile }), addedByName: hostile, link: "https://x/" },
];

test("subjects are fixed strings, except the request email's, which names the requester and dates on one line", () => {
  const subjects = kinds.map((k) => renderLeaveEmail(k).subject);
  assert.deepEqual(subjects, [
    'Eve <script>alert("x")</script> Bcc: victim@example.com asked for Nov 2 to Nov 6',
    "Your time off is approved",
    "Your time off request was declined",
    "Your time off request was cancelled",
    "A time off request was cancelled",
    "Time off was added for you",
  ]);
  for (const s of subjects) assert.doesNotMatch(s, /[\r\n]/);
  const oneDay = renderLeaveEmail({ ...kinds[0], leave: leave({ startDate: "2026-12-21", endDate: "2026-12-21" }) } as LeaveEmail);
  assert.match(oneDay.subject, /asked for Dec 21$/);
  const long = renderLeaveEmail({ ...kinds[0], leave: leave({ requesterName: "A".repeat(500) }) } as LeaveEmail);
  assert.equal(long.subject, `${"A".repeat(100)} asked for Nov 2 to Nov 6`);
  const newYear = renderLeaveEmail({ ...kinds[0], leave: leave({ requesterName: "Ana", startDate: "2026-12-30", endDate: "2027-01-02" }) } as LeaveEmail);
  assert.equal(newYear.subject, "Ana asked for Dec 30, 2026 to Jan 2, 2027", "across New Year, the years show");
  const blank = renderLeaveEmail({ ...kinds[0], leave: leave({ requesterName: "  " }) } as LeaveEmail);
  assert.match(blank.text, /^Someone asked for PTO, /);
});

test("user text is escaped in HTML and kept verbatim in plain text", () => {
  for (const k of kinds) {
    const { html, text } = renderLeaveEmail(k);
    assert.doesNotMatch(html, /<script>/, k.kind);
    // A requester's own email doesn't name them; every typed value it does show is escaped.
    if (k.kind !== "cancelled_requester") assert.match(html, /&lt;script&gt;/, k.kind);
    if (k.kind === "requested" || k.kind === "cancelled_approver") assert.match(text, /^Eve <script>/, k.kind);
  }
});

test("the request email reads like the OOOhm site's: one sentence, the note in quotes, who else is off", () => {
  const requested = renderLeaveEmail({
    kind: "requested",
    recipientName: "Sam",
    leave: leave({ requesterName: "Lena Park", leaveTypeName: "PTO", startDate: "2026-12-21", endDate: "2026-12-23", days: 3, note: "Visiting my parents in Busan" }),
    alsoOff: "Aisha Khan is off then too.",
    link: "https://x/approvals",
  });
  assert.equal(requested.subject, "Lena Park asked for Dec 21 to Dec 23");
  assert.match(requested.text, /^Lena Park asked for PTO, Mon, Dec 21 to Wed, Dec 23, 2026: 3 days\.\n\n\u201cVisiting my parents in Busan\u201d\n\nAisha Khan is off then too\.\n/);
  assert.match(requested.html, /Lena Park asked for <b[^>]*>PTO<\/b>, Mon, Dec 21 to Wed, Dec 23, 2026: 3 days\./);
  assert.match(requested.text, /https:\/\/x\/approvals/);

  const rejected = renderLeaveEmail({ kind: "rejected", recipientName: "Ana", leave: leave(), reason: "Launch week", link: "https://x/" });
  assert.match(rejected.text, /^Your PTO request was declined, Mon, Nov 2 to Fri, Nov 6, 2026: 5 days\./);
  assert.match(rejected.text, /Reason: \u201cLaunch week\u201d/);
  const rejectedNoReason = renderLeaveEmail({ kind: "rejected", recipientName: "Ana", leave: leave(), reason: null, link: "https://x/" });
  assert.doesNotMatch(rejectedNoReason.text, /Reason:/);
});

test("an approved requester sees the approver's note, when there is one", () => {
  const withNote = renderLeaveEmail({ kind: "approved", recipientName: "Ana", leave: leave(), reason: "Hand over X first", link: "https://x/" });
  assert.match(withNote.text, /^Your PTO is approved, Mon, Nov 2 to Fri, Nov 6, 2026: 5 days\./);
  assert.match(withNote.text, /Note from approver: \u201cHand over X first\u201d/);
  assert.match(withNote.html, /Note from approver/);
  const without = renderLeaveEmail({ kind: "approved", recipientName: "Ana", leave: leave(), reason: null, link: "https://x/" });
  assert.doesNotMatch(without.text, /Note from approver/);
});

test("names are one capped line, so a name cannot add paragraphs to someone else's email", () => {
  const forged = "Bob.\n\nYour OOOhm session expired. Re-verify at https://evil.example\n\n";
  const { text, subject } = renderLeaveEmail({
    kind: "requested",
    recipientName: "  Sam\r\n ",
    leave: leave({ requesterName: forged }),
    link: "https://x/approvals",
  });
  assert.match(text, /^Bob\. Your OOOhm session expired\. Re-verify at https:\/\/evil\.example asked for PTO, /);
  assert.equal(text.split("\n").filter((l) => l.includes("evil.example")).length, 1);
  assert.doesNotMatch(subject, /[\r\n]/);

  const long = renderLeaveEmail({ kind: "requested", recipientName: "Sam", leave: leave({ requesterName: "A".repeat(500) }), link: "https://x/" });
  assert.match(long.text, new RegExp(`^${"A".repeat(100)} asked for PTO, `, "m"));
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
    assert.match(text, /^ana@example\.com (asked for|cancelled their) PTO/m, kind);
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
  assert.match(text, /Mon, Nov 2, 2026 \(afternoon\): 0\.5 days\./);
});

test("emails take the company's accent: on the main button, and readable on pale accents", () => {
  const out = renderLeaveEmail({ ...kinds[0], approveLink: "https://x/approve/t" } as LeaveEmail, emailAccent({ theme: "cobalt", accentColor: null }));
  assert.match(out.html, /background:#2546d0;color:#ffffff[^"]*">Approve<\/a>/);
  assert.doesNotMatch(out.html, /#0f766e/, "no classic teal left over");

  const custom = renderLeaveEmail(kinds[1], emailAccent({ theme: "classic", accentColor: "#C026D3" }));
  assert.match(custom.html, /background:#c026d3/);

  // Marigold's yellow keeps its fill with dark text on it, and a darker ink for the wordmark.
  const pale = emailAccent({ theme: "marigold", accentColor: null });
  assert.equal(pale.accent, "#f2a900");
  assert.notEqual(pale.accentForeground, "#ffffff");
  assert.notEqual(pale.accentInk, "#f2a900");

  assert.deepEqual(emailAccent(null), DEFAULT_EMAIL_ACCENT);
  assert.deepEqual(emailAccent({ theme: "from-a-newer-version", accentColor: null }), DEFAULT_EMAIL_ACCENT);
  assert.match(renderLeaveEmail(kinds[1]).html, /background:#0f766e/, "classic teal by default");
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
      result: { id: "req-1", companyId: "c1" },
      outgoing: [
        { to: "down@example.com", email: kinds[1] },
        { to: "up@example.com", email: kinds[1] },
      ],
    }));
    assert.deepEqual(result, { id: "req-1", companyId: "c1" });
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
  await commitThenNotify(committingContext(async () => {}, tasks), async () => ({ result: { id: "req-1", companyId: "c1" }, outgoing: [] }));
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

  await assert.rejects(commitThenNotify(ctxWith("fails"), async () => ({ result: { id: "r1", companyId: "c1" }, outgoing })));
  assert.equal(deferred, 0, "a failed commit sends nothing");

  const result = await commitThenNotify(ctxWith("ok"), async () => ({ result: { id: "r2", companyId: "c1" }, outgoing }));
  assert.deepEqual(result, { id: "r2", companyId: "c1" });
  assert.equal(deferred, 1);
});

test("a request email with an approve link leads with Approve, then Open in OOOhm", () => {
  const approveLink = "https://x/approve/abc.def";
  const out = renderLeaveEmail({ kind: "requested", recipientName: "Jo", leave: leave(), link: "https://x/approvals", approveLink });
  assert.match(out.text, /Approve: https:\/\/x\/approve\/abc\.def\nDecline or look closer in OOOhm: https:\/\/x\/approvals/);
  assert.ok(out.html.indexOf(">Approve</a>") < out.html.indexOf(">Open in OOOhm</a>"));
  assert.match(out.html, /To decline, open the request in OOOhm/);
  assert.match(out.text, /To decline, open the request in OOOhm/, "the plain text says it too");
  assert.match(out.html, /<td bgcolor="#0f766e"[^>]*><a href="https:\/\/x\/approve\/abc\.def"/, "Outlook-safe: the cell carries the fill");
  const without = renderLeaveEmail({ kind: "requested", recipientName: "Jo", leave: leave(), link: "https://x/approvals" });
  assert.doesNotMatch(without.text, /Approve:/);
  assert.match(without.text, /Review in OOOhm: https:\/\/x\/approvals/);
});

test("time off added for someone says who added it, that it's approved, and the note", () => {
  const added = renderLeaveEmail({ kind: "added", recipientName: "Ana", leave: leave({ note: "Feel better" }), addedByName: "Mo Reyes", link: "https://x/" });
  assert.equal(added.subject, "Time off was added for you");
  assert.match(added.text, /^Mo Reyes added your PTO, Mon, Nov 2 to Fri, Nov 6, 2026: 5 days\. It's approved, so there's nothing you need to do\./);
  assert.match(added.text, /Note: \u201cFeel better\u201d/);
  const unnamed = renderLeaveEmail({ kind: "added", recipientName: "Ana", leave: leave(), addedByName: " ", link: "https://x/" });
  assert.match(unnamed.text, /^Someone added your PTO/);
  assert.doesNotMatch(unnamed.text, /Note:/);
});

test("heads-up time off: the requester hears it's booked, their manager is told without being asked", () => {
  const booked = renderLeaveEmail({ kind: "booked", recipientName: "Ana", leave: leave(), link: "https://x/" });
  assert.equal(booked.subject, "Your time off is booked");
  assert.match(booked.text, /^Your PTO is booked, Mon, Nov 2 to Fri, Nov 6, 2026: 5 days\. Enjoy it\.\n/);
  assert.doesNotMatch(booked.text, /approv/i);

  const told = renderLeaveEmail({
    kind: "heads_up",
    recipientName: "Sam",
    leave: leave({ requesterName: "Lena Park", note: "Visiting my parents" }),
    alsoOff: "Aisha Khan is off then too.",
    link: "https://x/calendar",
  });
  assert.equal(told.subject, "Lena Park is off Nov 2 to Nov 6");
  assert.match(
    told.text,
    /^Lena Park is taking PTO, Mon, Nov 2 to Fri, Nov 6, 2026: 5 days\. It's booked, so there's nothing you need to do\.\n\n“Visiting my parents”\n\nAisha Khan is off then too\.\n/,
  );
  assert.match(told.text, /Open in OOOhm: https:\/\/x\/calendar/);
  assert.doesNotMatch(told.text, /Approve|Review/);

  const hostileName = renderLeaveEmail({ kind: "heads_up", recipientName: hostile, leave: leave({ requesterName: hostile, note: hostile }), link: "https://x/" });
  assert.doesNotMatch(hostileName.subject, /[\r\n]/);
  assert.doesNotMatch(hostileName.html, /<script\b/i);
  assert.match(hostileName.html, /&lt;script&gt;/);
});
