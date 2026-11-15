import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MentionStore, SettingLabel } from "@/modules/people/application/deletion/mention-store";
import { redactStoredMentions } from "@/modules/people/application/deletion/redact-stored-mentions";
import { personRedactions } from "@/modules/people/domain/person-deletion";
import { first } from "../../../support/present";

/** An in-memory {@link MentionStore}: every row is "found" (the real store narrows by needle), and writes are kept. */
function memoryStore(rows: {
  events?: { id: string; payload: unknown }[];
  deliveries?: { id: string; status: string; body: string; lastResponseExcerpt: string | null }[];
  adapterErrors?: { id: string; lastError: string | null }[];
  importRuns?: { id: string; counts: unknown; report: unknown; sourceFileName: string }[];
  audit?: { id: string; before: unknown; after: unknown }[];
  notes?: { id: string; note: string | null; decisionNote: string | null }[];
  labels?: SettingLabel[];
}) {
  const writes: { kind: string; id: string; value: unknown }[] = [];
  const superseded: string[][] = [];
  const store: MentionStore = {
    events: async () => rows.events ?? [],
    setEventPayload: async (id, value) => void writes.push({ kind: "event", id, value }),
    supersedeAdapterAttempts: async (ids) => (superseded.push([...ids]), ids.length),
    deliveries: async () => rows.deliveries ?? [],
    rewriteDelivery: async (id, value) => void writes.push({ kind: "delivery", id, value }),
    adapterErrors: async () => rows.adapterErrors ?? [],
    setAdapterError: async (id, value) => void writes.push({ kind: "adapter", id, value }),
    importRuns: async () => rows.importRuns ?? [],
    setImportRunText: async (id, value) => void writes.push({ kind: "import", id, value }),
    auditSnapshots: async () => rows.audit ?? [],
    setAuditSnapshots: async (id, value) => void writes.push({ kind: "audit", id, value }),
    notes: async () => rows.notes ?? [],
    setNotes: async (id, value) => void writes.push({ kind: "notes", id, value }),
    settingLabels: async () => rows.labels ?? [],
    setSettingLabel: async (label, value) => void writes.push({ kind: label.kind, id: label.id, value }),
  };
  return { store, writes, superseded };
}

const PERSON = { id: "3f9a2c71-0b8e-4f4e-9d1c-2a7b6e5d4c3b", name: "Ana Lima", email: "ana@acme.test" };
const NOW = new Date("2026-03-02T10:00:00Z");
const scrub = personRedactions(PERSON, "scrubbed");

describe("redacting stored mentions (on an in-memory store)", () => {
  test("rewrites only what changes, counts each kind, and supersedes adapter attempts of redacted events", async () => {
    const { store, writes, superseded } = memoryStore({
      events: [
        { id: "e-1", payload: { userId: PERSON.id, name: "Ana Lima", email: "ana@acme.test" } },
        { id: "e-2", payload: { holiday: "New Year" } },
      ],
      notes: [
        { id: "r-1", note: "Covering for Ana Lima", decisionNote: null },
        { id: "r-2", note: "Nothing here", decisionNote: null },
      ],
      labels: [{ kind: "api_key", id: "k-1", text: "Ana Lima's key" }],
      audit: [{ id: "a-1", before: null, after: { email: "ana@acme.test" } }],
    });
    const done = await redactStoredMentions(store, scrub, NOW);
    assert.deepEqual(done, {
      eventsRedacted: 1,
      deliveriesRedacted: 0,
      deliveriesFailed: 0,
      importRunsRedacted: 0,
      auditEntriesRedacted: 1,
      notesRedacted: 1,
      settingsRedacted: 1,
    });
    assert.deepEqual(superseded, [["e-1"]]);
    assert.deepEqual(writes.map((w) => `${w.kind}:${w.id}`), ["event:e-1", "audit:a-1", "notes:r-1", "api_key:k-1"]);
    assert.equal(JSON.stringify(writes).includes("ana@acme.test"), false);
    assert.equal(JSON.stringify(writes).includes("Ana Lima"), false);
  });

  test("a pending delivery whose body is not JSON is rewritten as text and stopped; a sent one is only rewritten", async () => {
    const { store, writes } = memoryStore({
      deliveries: [
        { id: "d-1", status: "pending", body: "to ana@acme.test", lastResponseExcerpt: null },
        { id: "d-2", status: "delivered", body: "to ana@acme.test", lastResponseExcerpt: "ok" },
        { id: "d-3", status: "pending", body: JSON.stringify({ email: "ana@acme.test" }), lastResponseExcerpt: null },
      ],
    });
    const done = await redactStoredMentions(store, scrub, NOW);
    assert.equal(done.deliveriesFailed, 1);
    assert.equal(done.deliveriesRedacted, 2);
    const fails = Object.fromEntries(writes.map((w) => [w.id, (w.value as { fail: boolean }).fail]));
    assert.deepEqual(fails, { "d-1": true, "d-2": false, "d-3": false });
  });

  test("keeping records replaces the email but leaves names in free text", async () => {
    const { store, writes } = memoryStore({ notes: [{ id: "r-1", note: "Ana Lima, ana@acme.test", decisionNote: null }] });
    await redactStoredMentions(store, personRedactions(PERSON, "records_kept"), NOW);
    const note = (first(writes).value as { note: string }).note;
    assert.match(note, /^Ana Lima, deleted\+/);
  });

  test("an adapter error that changes is written; one that does not is left, and neither is counted", async () => {
    const { store, writes } = memoryStore({ adapterErrors: [{ id: "x-1", lastError: "no user ana@acme.test" }, { id: "x-2", lastError: "timeout" }] });
    const done = await redactStoredMentions(store, scrub, NOW);
    assert.deepEqual(writes.map((w) => w.id), ["x-1"]);
    assert.equal(Object.values(done).reduce((a, b) => a + b, 0), 0);
  });
});
