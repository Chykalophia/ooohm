import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { deactivationMessage } from "@/app/admin/people/deactivation-message";

const none = { requestsReassigned: 0, liveApiKeysCreated: 0, liveWebhookEndpointsCreated: 0 };

describe("deactivation message", () => {
  test("nothing else to report: just the deactivation", () => {
    assert.equal(deactivationMessage(none), "Deactivated. They're signed out everywhere.");
  });

  test("moved requests are counted", () => {
    assert.equal(deactivationMessage({ ...none, requestsReassigned: 1 }), "Deactivated. They're signed out everywhere. 1 pending request moved to another approver.");
  });

  test("live API keys and webhook endpoints they created are pointed out, singular and plural", () => {
    assert.equal(
      deactivationMessage({ ...none, liveApiKeysCreated: 1 }),
      "Deactivated. They're signed out everywhere. They created 1 API key that still works. Review it under Admin → Integrations.",
    );
    assert.equal(
      deactivationMessage({ requestsReassigned: 2, liveApiKeysCreated: 2, liveWebhookEndpointsCreated: 1 }),
      "Deactivated. They're signed out everywhere. 2 pending requests moved to another approver. They created 2 API keys and 1 webhook endpoint that still work. Review them under Admin → Integrations.",
    );
    assert.equal(
      deactivationMessage({ ...none, liveWebhookEndpointsCreated: 3 }),
      "Deactivated. They're signed out everywhere. They created 3 webhook endpoints that still work. Review them under Admin → Integrations.",
    );
  });
});
