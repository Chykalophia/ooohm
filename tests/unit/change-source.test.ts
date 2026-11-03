import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adapterIdOf,
  adapterSyncProcess,
  byApiKey,
  bySystem,
  byUser,
  CHANGE_PROCESSES,
  type ChangeSourceNames,
  changeSourceLabel,
  personIdOf,
  recordedChangeSource,
  through,
} from "@/domain/change-source";
import { eventActor, eventAttribution } from "@/domain/events";

const names: ChangeSourceNames = {
  person: (id) => ({ u1: "Peter Krzyzek" })[id],
  apiKey: (id) => ({ k1: { name: "Zapier", prefix: "ooohm_ab12cd34" } })[id],
  adapter: (id) => ({ gusto: "Gusto" })[id],
};

test("process identifiers are stable strings; an adapter sync carries its adapter id", () => {
  assert.deepEqual(Object.values(CHANGE_PROCESSES), [
    "year_rollover",
    "retention",
    "timeoff_import",
    "scheduled_scrub",
    "holiday_change",
    "working_days_change",
    "email_link",
    "first_install",
  ]);
  assert.equal(adapterSyncProcess("gusto"), "adapter_sync:gusto");
  assert.equal(adapterIdOf("adapter_sync:gusto"), "gusto");
  assert.equal(adapterIdOf("adapter_sync:"), null);
  assert.equal(adapterIdOf("year_rollover"), null);
});

test("sources: a person directly or through something, a key with its creator, or a process with nobody", () => {
  assert.deepEqual(byUser("u1"), { kind: "user", userId: "u1" });
  assert.equal("via" in byUser("u1"), false, "no via key when there is none");
  assert.deepEqual(through(byUser("u1"), adapterSyncProcess("gusto")), { kind: "user", userId: "u1", via: "adapter_sync:gusto" });
  assert.deepEqual(byApiKey({ userId: "u1", apiKeyId: "k1" }), { kind: "api_key", userId: "u1", apiKeyId: "k1" });
  assert.deepEqual(through(byApiKey({ userId: "u1", apiKeyId: "k1" }), "timeoff_import"), { kind: "api_key", userId: "u1", apiKeyId: "k1", via: "timeoff_import" });
  assert.deepEqual(bySystem("year_rollover"), { kind: "system", process: "year_rollover" });
  assert.equal(personIdOf(byUser("u1")), "u1");
  assert.equal(personIdOf(byApiKey({ userId: "u1", apiKeyId: "k1" })), "u1");
  assert.equal(personIdOf(bySystem("year_rollover")), null);
});

test("labels name the person, what they acted through, the key, or the process", () => {
  const label = (s: Parameters<typeof changeSourceLabel>[0]) => changeSourceLabel(s, names);
  assert.equal(label(byUser("u1")), "Peter Krzyzek");
  assert.equal(label(byUser("u1", adapterSyncProcess("gusto"))), "Peter Krzyzek, via Gusto sync");
  assert.equal(label(byUser("u1", "timeoff_import")), "Peter Krzyzek, via time-off import");
  assert.equal(label(byUser("u1", "holiday_change")), "Peter Krzyzek, via holiday change");
  assert.equal(label(byUser("u1", "working_days_change")), "Peter Krzyzek, via working days change");
  assert.equal(label(byApiKey({ userId: "u1", apiKeyId: "k1" })), "Peter Krzyzek, via API key ‘Zapier’ (ooohm_ab12cd34…)");
  assert.equal(label(byApiKey({ userId: "u1", apiKeyId: "k1" }, "timeoff_import")), "Peter Krzyzek, via time-off import with API key ‘Zapier’ (ooohm_ab12cd34…)");
  assert.equal(label(bySystem("year_rollover")), "System: year rollover");
  assert.equal(label(bySystem("retention")), "System: retention");
  assert.equal(label(bySystem(adapterSyncProcess("gusto"))), "System: scheduled Gusto sync");
});

test("labels degrade calmly: a deleted person or key, an unknown name, adapter or process", () => {
  const label = (s: Parameters<typeof changeSourceLabel>[0]) => changeSourceLabel(s, names);
  assert.equal(label({ kind: "user", userId: null }), "A deleted person");
  assert.equal(label({ kind: "user", userId: "nobody-known" }), "Someone");
  assert.equal(label({ kind: "api_key", userId: "u1", apiKeyId: null }), "Peter Krzyzek, via an API key");
  assert.equal(label({ kind: "api_key", userId: null, apiKeyId: "k1" }), "A deleted person, via API key ‘Zapier’ (ooohm_ab12cd34…)");
  assert.equal(label(bySystem(adapterSyncProcess("retired"))), "System: scheduled retired sync", "an unregistered adapter shows its id");
  assert.equal(label({ kind: "system", process: "unknown" }), "System: unknown process");
  assert.equal(label({ kind: "system", process: "from_a_later_version" }), "System: from_a_later_version");
});

test("stored columns read back as the source that wrote them", () => {
  const row = { actorKind: "user", actorId: "u1", apiKeyId: null, actorVia: "adapter_sync:gusto", actorProcess: null };
  assert.equal(changeSourceLabel(recordedChangeSource(row), names), "Peter Krzyzek, via Gusto sync");
  assert.deepEqual(recordedChangeSource({ ...row, actorKind: "api_key", apiKeyId: "k1", actorVia: null }), { kind: "api_key", userId: "u1", apiKeyId: "k1", via: null });
  assert.deepEqual(recordedChangeSource({ actorKind: "system", actorId: null, apiKeyId: null, actorVia: null, actorProcess: "year_rollover" }), {
    kind: "system",
    process: "year_rollover",
  });
});

test("events publish the source as `actor`, keeping `actorId` as the person or null", () => {
  assert.deepEqual(eventActor(byUser("u1")), { type: "user", id: "u1" });
  assert.deepEqual(eventActor(byUser("u1", adapterSyncProcess("gusto"))), { type: "user", id: "u1", via: "adapter_sync:gusto" });
  assert.deepEqual(eventActor(byApiKey({ userId: "u1", apiKeyId: "k1" })), { type: "api_key", id: "u1", apiKeyId: "k1" });
  assert.deepEqual(eventActor(bySystem("year_rollover")), { type: "system", process: "year_rollover" });
  assert.deepEqual(eventAttribution(bySystem(adapterSyncProcess("gusto"))), { actorId: null, actor: { type: "system", process: "adapter_sync:gusto" } });
  assert.deepEqual(eventAttribution(byApiKey({ userId: "u1", apiKeyId: "k1" })), { actorId: "u1", actor: { type: "api_key", id: "u1", apiKeyId: "k1" } });
});
