import "server-only";
/**
 * Replaces a deleted person's name and email in everything stored that mentions them:
 * outbox payloads (and so what adapters are handed), webhook bodies and response
 * excerpts, an adapter's error text, import reports, the remaining audit snapshots,
 * leave notes, and the labels admins gave company settings (API key names, webhook
 * descriptions, department, leave type and holiday names).
 */
import {
  type PersonRedaction,
  redactionNeedles,
  redactJson,
  redactJsonText,
  redactText,
} from "@/modules/people/domain/person-deletion";
import type { MentionStore } from "./mention-store";

/** What the redaction changed, by kind of record. Counts only. */
export interface RedactionCounts {
  eventsRedacted: number;
  deliveriesRedacted: number;
  deliveriesFailed: number;
  importRunsRedacted: number;
  auditEntriesRedacted: number;
  notesRedacted: number;
  /** API key names, webhook descriptions and catalog names that mentioned them. */
  settingsRedacted: number;
}

/** Redacts every kind of stored record in turn; each step reads only rows that hold a needle. */
export async function redactStoredMentions(store: MentionStore, redactions: PersonRedaction, now: Date): Promise<RedactionCounts> {
  const needles = redactionNeedles(redactions);
  const eventsRedacted = await redactEvents(store, needles, redactions, now);
  const deliveries = await redactDeliveries(store, needles, redactions, now);
  await redactAdapterErrors(store, needles, redactions);
  const importRunsRedacted = await redactImportRuns(store, needles, redactions);
  const auditEntriesRedacted = await redactAuditSnapshots(store, needles, redactions);
  const notesRedacted = await redactNotes(store, needles, redactions);
  const settingsRedacted = await redactSettingLabels(store, needles, redactions);
  return { eventsRedacted, ...deliveries, importRunsRedacted, auditEntriesRedacted, notesRedacted, settingsRedacted };
}

/** Outbox payloads; an adapter attempt in flight with the old payload loses its outcome and runs again, redacted. */
async function redactEvents(store: MentionStore, needles: readonly string[], r: PersonRedaction, now: Date): Promise<number> {
  const redacted: string[] = [];
  for (const event of await store.events(needles)) {
    const out = redactJson(event.payload, r);
    if (!out.changed) continue;
    await store.setEventPayload(event.id, out.value);
    redacted.push(event.id);
  }
  await store.supersedeAdapterAttempts(redacted, now);
  return redacted.length;
}

/**
 * Webhook bodies and response excerpts. A body that cannot be redacted safely (not JSON,
 * or still holding the email afterwards) is rewritten as plain text and, if still
 * pending, stopped for good, so it never sends their data.
 */
async function redactDeliveries(store: MentionStore, needles: readonly string[], r: PersonRedaction, now: Date) {
  const done = { deliveriesRedacted: 0, deliveriesFailed: 0 };
  for (const d of await store.deliveries(needles)) {
    const excerpt = d.lastResponseExcerpt === null ? null : redactText(d.lastResponseExcerpt, r);
    const body = redactJsonText(d.body, r);
    if (body === null) {
      const fail = d.status === "pending";
      await store.rewriteDelivery(d.id, { body: redactText(d.body, r), lastResponseExcerpt: excerpt, fail, at: now });
      if (fail) done.deliveriesFailed++;
      else done.deliveriesRedacted++;
      continue;
    }
    if (!body.changed && excerpt === d.lastResponseExcerpt) continue;
    await store.rewriteDelivery(d.id, { body: body.text, lastResponseExcerpt: excerpt, fail: false, at: now });
    done.deliveriesRedacted++;
  }
  return done;
}

async function redactAdapterErrors(store: MentionStore, needles: readonly string[], r: PersonRedaction): Promise<void> {
  for (const a of await store.adapterErrors(needles)) {
    const lastError = redactText(a.lastError ?? "", r);
    if (lastError !== a.lastError) await store.setAdapterError(a.id, lastError);
  }
}

async function redactImportRuns(store: MentionStore, needles: readonly string[], r: PersonRedaction): Promise<number> {
  let n = 0;
  for (const run of await store.importRuns(needles)) {
    const report = redactJson(run.report, r);
    const counts = redactJson(run.counts, r);
    const sourceFileName = redactText(run.sourceFileName, r);
    if (!report.changed && !counts.changed && sourceFileName === run.sourceFileName) continue;
    await store.setImportRunText(run.id, { report: report.value, counts: counts.value, sourceFileName });
    n++;
  }
  return n;
}

async function redactAuditSnapshots(store: MentionStore, needles: readonly string[], r: PersonRedaction): Promise<number> {
  let n = 0;
  for (const row of await store.auditSnapshots(needles)) {
    const before = redactJson(row.before, r);
    const after = redactJson(row.after, r);
    if (!before.changed && !after.changed) continue;
    await store.setAuditSnapshots(row.id, { before: before.value, after: after.value });
    n++;
  }
  return n;
}

async function redactNotes(store: MentionStore, needles: readonly string[], r: PersonRedaction): Promise<number> {
  let n = 0;
  for (const row of await store.notes(needles)) {
    const note = row.note === null ? null : redactText(row.note, r);
    const decisionNote = row.decisionNote === null ? null : redactText(row.decisionNote, r);
    if (note === row.note && decisionNote === row.decisionNote) continue;
    await store.setNotes(row.id, { note, decisionNote });
    n++;
  }
  return n;
}

async function redactSettingLabels(store: MentionStore, needles: readonly string[], r: PersonRedaction): Promise<number> {
  let n = 0;
  for (const label of await store.settingLabels(needles)) {
    const text = redactText(label.text, r);
    if (text === label.text) continue;
    await store.setSettingLabel(label, text);
    n++;
  }
  return n;
}
