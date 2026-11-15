import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AUDIT_PAGE_SIZE, type AuditLogDTO } from "@/modules/audit";
import type { ApprovalTriageDTO, InboxItemDTO } from "@/modules/approvals";
import type { WebhookDeliveryDTO } from "@/modules/integrations";
import { presentAuditLog } from "@/modules/audit/ui/audit-log-presenter";
import { presentApprovals, presentPendingRequest, readApprovalsView } from "@/modules/approvals/ui/approvals-presenter";
import { endpointSummary, presentDelivery } from "@/modules/integrations/ui/webhook-endpoint-presenter";
import { calendarFilterItems, calendarMonthHref, monthGridCaption, yearViewMonth } from "@/modules/calendar/ui/calendar-presenter";
import { listHref } from "@/app/_lib/paging";

const auditLog = (over: Partial<AuditLogDTO> = {}): AuditLogDTO => ({
  timezone: "Europe/Berlin",
  entries: [],
  previous: null,
  next: null,
  oldestFirst: false,
  size: AUDIT_PAGE_SIZE,
  filters: { query: undefined, action: undefined, actorId: undefined, subjectUserId: undefined, from: undefined, to: undefined },
  people: [{ id: "u1", label: "Ana" }],
  actions: [{ value: "leave.approved", label: "Approved leave" }],
  ...over,
});

describe("presentAuditLog", () => {
  const link = (q: Record<string, string | undefined>) => listHref("/admin/audit", q);

  test("an unfiltered log: no chips, plain links, the empty wording for a new company", () => {
    const view = presentAuditLog(auditLog(), link);
    assert.deepEqual(view.active, []);
    assert.equal(view.filterCount, 0);
    assert.equal(view.clearHref, "/admin/audit");
    assert.equal(view.sortHref, "/admin/audit?order=oldest");
    assert.equal(view.caption, "Audit log, newest first");
    assert.equal(view.empty, "Nothing has changed yet.");
  });

  test("filters become chips that remove themselves, and every link keeps the rest", () => {
    const view = presentAuditLog(
      auditLog({ oldestFirst: true, filters: { query: "ana", action: "leave.approved", actorId: "u1", subjectUserId: undefined, from: undefined, to: undefined } }),
      link,
    );
    assert.deepEqual(
      view.active.map((c) => [c.label, c.value, c.removeHref]),
      [
        ["Search", "ana", "/admin/audit?action=leave.approved&actor=u1&order=oldest"],
        ["What", "Approved leave", "/admin/audit?q=ana&actor=u1&order=oldest"],
        ["Done by", "Ana", "/admin/audit?q=ana&action=leave.approved&order=oldest"],
      ],
    );
    assert.equal(view.filterCount, 2, "the search is not counted as a filter");
    assert.equal(view.clearHref, "/admin/audit?order=oldest");
    assert.equal(view.sortLabel, "When: oldest first. Show newest first.");
    assert.equal(view.empty, "Nothing matches. Try fewer words or filters.");
  });

  test("only people and actions the pickers offer are filter links", () => {
    const view = presentAuditLog(auditLog(), link);
    assert.equal(view.canFilterByPerson("u1"), true);
    assert.equal(view.canFilterByPerson("gone"), false);
    assert.equal(view.canFilterByPerson(null), false);
    assert.equal(view.canFilterByAction("leave.approved"), true);
    assert.equal(view.canFilterByAction("from.a.newer.version"), false);
  });
});

const delivery = (over: Partial<WebhookDeliveryDTO> = {}): WebhookDeliveryDTO => ({
  id: "d1",
  endpointId: "e1",
  eventId: "ev1",
  eventType: "leave.approved",
  status: "delivered",
  attempts: 1,
  nextAttemptAt: new Date("2026-03-02T10:05:00Z"),
  lastAttemptAt: new Date("2026-03-02T10:00:01Z"),
  lastStatusCode: 200,
  lastLatencyMs: 41,
  lastError: null,
  deliveredAt: new Date("2026-03-02T10:00:01Z"),
  createdAt: new Date("2026-03-02T10:00:00Z"),
  ...over,
});

describe("presentDelivery", () => {
  test("a delivered event: its attempts and answer on one line, and it can be sent again", () => {
    const view = presentDelivery(delivery(), "UTC", true);
    assert.match(view.detail, / · 1 attempt of \d+ · HTTP 200 in 41 ms$/);
    assert.equal(view.retrying, false);
    assert.equal(view.canRedeliver, true);
  });

  test("a retry names its error and the next try, and can't be sent again yet", () => {
    const view = presentDelivery(delivery({ status: "pending", attempts: 2, lastStatusCode: null, lastError: "timeout" }), "UTC", true);
    assert.match(view.detail, / · 2 attempts of \d+ · timeout · next try /);
    assert.equal(view.retrying, true);
    assert.equal(view.canRedeliver, false);
  });

  test("a queued event shows only when it was queued; an off endpoint sends nothing again", () => {
    const queued = presentDelivery(delivery({ status: "pending", attempts: 0, lastStatusCode: null }), "UTC", true);
    assert.doesNotMatch(queued.detail, /·/);
    assert.equal(presentDelivery(delivery(), "UTC", false).canRedeliver, false);
  });

  test("the endpoint's summary", () => {
    assert.match(endpointSummary({ enabled: true, eventTypes: ["a", "b"], createdAt: new Date() }, "UTC"), /^Sends 2 kinds of events\. Added /);
    assert.equal(
      endpointSummary({ enabled: false, eventTypes: [], createdAt: new Date() }, "UTC"),
      "Nothing new is queued for it, and queued deliveries wait until you turn it back on.",
    );
  });
});

const triage = (over: Partial<ApprovalTriageDTO> = {}): ApprovalTriageDTO => ({
  view: "mine",
  needsYouTotal: 0,
  waitingTotal: 0,
  settledDays: 30,
  timeZone: "UTC",
  items: [],
  settled: [],
  previous: null,
  next: null,
  ...over,
});

describe("presentApprovals", () => {
  const href = (v: string | undefined) => listHref("/approvals", { view: v });

  test("reads ?view=", () => {
    assert.equal(readApprovalsView("waiting"), "others");
    assert.equal(readApprovalsView(["settled"]), "settled");
    assert.equal(readApprovalsView("nonsense"), "mine");
  });

  test("Waiting on others shows only when something waits there", () => {
    assert.deepEqual(presentApprovals(triage(), href).tabs.map((t) => t.label), ["Needs you", "Settled"]);
    const busy = presentApprovals(triage({ waitingTotal: 2 }), href);
    assert.deepEqual(busy.tabs.map((t) => [t.label, t.href]), [
      ["Needs you", "/approvals"],
      ["Waiting on others", "/approvals?view=waiting"],
      ["Settled", "/approvals?view=settled"],
    ]);
    assert.equal(busy.empty, "Nothing needs you right now. 2 requests are waiting on someone else.");
  });

  test("an empty Waiting on others falls back to Needs you", () => {
    const view = presentApprovals(triage({ view: "others" }), href);
    assert.equal(view.view, "mine");
    assert.equal(view.empty, "Nothing needs you right now.");
  });

  test("a pending request's lines name its assignee only when that is someone else", () => {
    const r = {
      id: "r1",
      startDate: "2026-08-03",
      endDate: "2026-08-03",
      dayPortion: "full",
      days: 1,
      leaveTypeName: "Vacation",
      requesterName: "",
      requesterEmail: "ana@example.com",
      approverId: "u9",
      approverName: "Jonas",
    } as InboxItemDTO;
    const view = presentPendingRequest(r, "u1");
    assert.equal(view.who, "ana@example.com");
    assert.equal(view.summary, "Vacation · 1 day · Assigned to Jonas");
    assert.equal(view.label, `Request from ana@example.com, ${view.dates}`);
    assert.equal(presentPendingRequest(r, "u9").summary, "Vacation · 1 day");
  });
});

describe("calendar presenter", () => {
  test("month links leave out the default filter", () => {
    assert.equal(calendarMonthHref("2026-08", "me"), "/calendar?month=2026-08");
    assert.equal(calendarMonthHref("2026-08", "team"), "/calendar?month=2026-08&show=team");
  });

  test("the year view's Month tab opens this month in the current year, else January", () => {
    assert.equal(yearViewMonth({ year: 2026, current: 2026, today: "2026-08-14" }), "2026-08");
    assert.equal(yearViewMonth({ year: 2027, current: 2026, today: "2026-08-14" }), "2027-01");
  });

  test("the caption and pills name whose time off", () => {
    const labels = { me: "Just me", team: "My team", everyone: "Acme" };
    assert.equal(monthGridCaption("August 2026", "everyone", labels), "Acme's time off and company holidays in August 2026");
    assert.match(monthGridCaption("August 2026", "me", labels), /^Your time off and company holidays in /);
    assert.deepEqual(calendarFilterItems("2026-08", "team", ["me", "team"], labels), [
      { href: "/calendar?month=2026-08", label: "Just me", current: undefined },
      { href: "/calendar?month=2026-08&show=team", label: "My team", current: "page" },
    ]);
  });
});
