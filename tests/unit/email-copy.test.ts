import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeEmailCopy } from "@/domain/email-template";
import { renderInviteEmail } from "@/server/notifications/templates/invite";
import { LEAVE_KINDS, type LeaveSummary, leaveVariables, renderLeaveEmail } from "@/server/notifications/templates/leave";

const leave = (over: Partial<LeaveSummary> = {}): LeaveSummary => ({
  requesterName: "Ana Ruiz",
  leaveTypeName: "PTO",
  startDate: "2026-11-02",
  endDate: "2026-11-06",
  dayPortion: "full",
  days: 5,
  note: "Family visit",
  ...over,
});
const hostile = 'Eve <script>alert("x")</script>\r\nBcc: victim@example.com';

test("a company's subject and message replace the defaults, with the variables filled", () => {
  const out = renderLeaveEmail(
    { kind: "requested", recipientName: "Mo", leave: leave(), link: "https://x/approvals" },
    undefined,
    { subject: "Time off: {{requester}} ({{days}})", message: "Hi {{recipient}}, {{requester}} would like {{leave_type}} on {{dates}}." },
  );
  assert.equal(out.subject, "Time off: Ana Ruiz (5 days)");
  assert.match(out.text, /^Hi Mo, Ana Ruiz would like PTO on Mon, Nov 2 to Fri, Nov 6, 2026\.\n\n“Family visit”/);
  assert.match(out.html, /<h1[^>]*>Hi Mo, Ana Ruiz would like <b style="font-weight:600">PTO<\/b> on Mon, Nov 2/);
  assert.match(out.html, /<title>Time off: Ana Ruiz \(5 days\)<\/title>/);
  assert.match(out.text, /Review in OOOhm: https:\/\/x\/approvals/, "the buttons and links stay");
});

test("only the field a company changed differs; the other keeps its default", () => {
  const email = { kind: "approved", recipientName: "Ana", leave: leave(), reason: null, link: "https://x/" } as const;
  const out = renderLeaveEmail(email, undefined, { subject: "Enjoy your break", message: null });
  assert.equal(out.subject, "Enjoy your break");
  assert.equal(out.text, renderLeaveEmail(email).text);
});

test("further paragraphs follow the request's details, before the buttons", () => {
  const out = renderLeaveEmail(
    { kind: "rejected", recipientName: "Ana", leave: leave(), reason: "Launch week", link: "https://x/" },
    undefined,
    { subject: null, message: "Your {{leave_type}} was declined.\n\nTalk to your manager\nif you have questions." },
  );
  assert.match(out.text, /^Your PTO was declined\.\n\nReason: “Launch week”\n\nTalk to your manager\nif you have questions\.\n\nOpen in OOOhm/);
  assert.ok(out.html.indexOf("Launch week") < out.html.indexOf("Talk to your manager"));
  assert.match(out.html, /<p style="margin:0 0 12px;">Talk to your manager<br>if you have questions\.<\/p>/);
});

test("typed values and the copy itself are escaped, and the subject stays one line", () => {
  const out = renderLeaveEmail(
    { kind: "requested", recipientName: hostile, leave: leave({ requesterName: hostile, leaveTypeName: "<i>PTO</i>" }), link: "https://x/" },
    undefined,
    { subject: "{{requester}} <b>{{leave_type}}</b>", message: "<a href='evil'>{{requester}}</a> {{leave_type}}" },
  );
  assert.doesNotMatch(out.subject, /[\r\n]/);
  assert.doesNotMatch(out.html, /<script|<a href='evil'|<i>PTO/i);
  assert.match(out.html, /&lt;a href=&#39;evil&#39;&gt;/);
});

test("every leave kind's default copy uses only its own variables, so it saves as it is", () => {
  for (const [kind, spec] of Object.entries(LEAVE_KINDS)) {
    const names = leaveVariables(kind as keyof typeof LEAVE_KINDS).map((v) => v.name);
    assert.doesNotThrow(() => normalizeEmailCopy(spec.defaults, { subject: names, message: names }), kind);
  }
});

test("the invite takes a company's copy too; the greeting, button and expiry stay", () => {
  const out = renderInviteEmail(
    { recipientName: "Ana", inviterName: "Peter", companyName: "Acme", link: "https://x/verify", signInUrl: "https://x/sign-in" },
    undefined,
    { subject: "Welcome to {{company}}", message: "{{inviter}} set you up in our leave tracker.\n\nQuestions? Ask in #people." },
  );
  assert.equal(out.subject, "Welcome to Acme");
  assert.match(out.text, /^Hi Ana,\n\nPeter set you up in our leave tracker\.\n\nQuestions\? Ask in #people\.\n\nSign in: https:\/\/x\/verify/);
  assert.match(out.html, /Sign in to OOOhm<\/a>/);
});

test("a subject that fills to nothing goes out as the default subject", () => {
  const base = { recipientName: "", inviterName: "Peter", companyName: "Acme", link: "https://x/v", signInUrl: "https://x/sign-in" };
  assert.equal(renderInviteEmail(base, undefined, { subject: "{{recipient}}", message: null }).subject, "You're invited to OOOhm");
  const out = renderLeaveEmail(
    { kind: "approved", recipientName: " ", leave: leave(), reason: null, link: "https://x/" },
    undefined,
    { subject: " {{recipient}} ", message: null },
  );
  assert.equal(out.subject, renderLeaveEmail({ kind: "approved", recipientName: " ", leave: leave(), reason: null, link: "https://x/" }).subject);
});
