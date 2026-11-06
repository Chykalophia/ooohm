import { test } from "node:test";
import { emailAccent } from "@/lib/email-layout";
import { renderSignInEmail } from "@/lib/sign-in-email";
import { renderInviteEmail } from "@/server/notifications/templates/invite";
import { type LeaveEmail, type LeaveSummary, renderLeaveEmail } from "@/server/notifications/templates/leave";

/**
 * Every email OOOhm sends, byte for byte, for a fixed set of inputs. It pins the
 * default wording and layout, so a refactor of how emails are built changes nothing
 * people receive. After a deliberate change to an email, update the snapshot with
 * `pnpm test -- --test-update-snapshots` and review the diff.
 */

const leave = (over: Partial<LeaveSummary> = {}): LeaveSummary => ({
  requesterName: "Ana Ruiz",
  leaveTypeName: "PTO",
  startDate: "2026-11-02",
  endDate: "2026-11-06",
  dayPortion: "full",
  days: 5,
  note: null,
  ...over,
});
const hostile = 'Eve <script>alert("x")</script>\r\nBcc: victim@example.com';
const cause = { kind: "holidays", added: [{ date: "2026-11-03", name: "Founders' Day" }], removed: [] } as const;

const leaveCases: Record<string, LeaveEmail> = {
  requested: { kind: "requested", recipientName: "Mo", leave: leave({ note: "Family visit" }), link: "https://x/approvals" },
  requestedWithApproveAndOverlap: {
    kind: "requested",
    recipientName: "Mo",
    leave: leave({ dayPortion: "am", startDate: "2026-11-02", endDate: "2026-11-02", days: 0.5 }),
    alsoOff: "Aisha Khan is off then too.",
    link: "https://x/approvals",
    approveLink: "https://x/approve/abc.def",
  },
  requestedHostile: { kind: "requested", recipientName: hostile, leave: leave({ requesterName: hostile, note: hostile }), link: "https://x/approvals" },
  approved: { kind: "approved", recipientName: "Ana", leave: leave(), reason: null, link: "https://x/" },
  approvedWithNote: { kind: "approved", recipientName: "Ana", leave: leave(), reason: "Hand over X first", link: "https://x/" },
  added: { kind: "added", recipientName: "Ana", leave: leave({ note: "Feel better" }), addedByName: "Mo Reyes", link: "https://x/" },
  addedUnnamed: { kind: "added", recipientName: "Ana", leave: leave(), addedByName: " ", link: "https://x/" },
  rejected: { kind: "rejected", recipientName: "Ana", leave: leave(), reason: "Launch week", link: "https://x/" },
  rejectedHostile: { kind: "rejected", recipientName: hostile, leave: leave({ requesterName: hostile }), reason: hostile, link: "https://x/" },
  cancelledRequester: { kind: "cancelled_requester", recipientName: "Ana", leave: leave(), link: "https://x/" },
  cancelledApprover: { kind: "cancelled_approver", recipientName: "Mo", leave: leave(), link: "https://x/approvals" },
  recountedFewer: { kind: "recounted", recipientName: "Ana", leave: leave({ days: 4 }), previousDays: 5, cause, overdrawn: null, link: "https://x/" },
  recountedOver: {
    kind: "recounted",
    recipientName: "Ana",
    leave: leave({ days: 5 }),
    previousDays: 3,
    cause: { kind: "working_days" },
    overdrawn: "1 day over your PTO balance for 2026",
    link: "https://x/",
  },
  recountedSameTotal: {
    kind: "recounted",
    recipientName: "Ana",
    leave: leave({ startDate: "2026-12-30", endDate: "2027-01-04", days: 3 }),
    previousDays: 3,
    cause: { kind: "working_days" },
    overdrawn: "1 day over your PTO balance for 2027",
    link: "https://x/",
  },
  recountedFree: {
    kind: "recounted",
    recipientName: "Ana",
    leave: leave({ startDate: "2026-11-03", endDate: "2026-11-03", days: 0 }),
    previousDays: 1,
    cause,
    overdrawn: null,
    link: "https://x/",
  },
};

const plum = emailAccent({ theme: "plum", accentColor: null });

test("leave emails are unchanged", (t) => {
  const out = Object.fromEntries(Object.entries(leaveCases).map(([name, email]) => [name, renderLeaveEmail(email)]));
  t.assert.snapshot(out);
});

test("leave emails take the company accent", (t) => {
  t.assert.snapshot(renderLeaveEmail(leaveCases.requestedWithApproveAndOverlap, plum));
});

test("the invite is unchanged", (t) => {
  const base = {
    recipientName: "Ana",
    inviterName: "Peter",
    companyName: "Acme",
    link: "https://ooohm.team/api/auth/magic-link/verify?token=abc&callbackURL=%2F",
    signInUrl: "https://ooohm.team/sign-in",
  };
  t.assert.snapshot({
    plain: renderInviteEmail(base),
    hostile: renderInviteEmail({ ...base, recipientName: "", inviterName: hostile, companyName: "A & B" }, plum),
  });
});

test("the sign-in email is unchanged", (t) => {
  t.assert.snapshot(renderSignInEmail("https://ooohm.team/api/auth/magic-link/verify?token=abc", plum));
});
