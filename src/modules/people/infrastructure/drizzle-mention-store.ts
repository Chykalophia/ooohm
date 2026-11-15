import "server-only";
import type { Transaction } from "@/db/types";
import type { MentionStore } from "@/modules/people/application/deletion/mention-store";
import {
  listAdapterErrorsMentioning,
  listAuditMentioning,
  listDeliveriesMentioning,
  listEventsMentioning,
  listImportRunsMentioning,
  listNotesMentioning,
  listSettingLabelsMentioning,
  rewriteDelivery,
  setAdapterError,
  setAuditSnapshots,
  setEventPayload,
  setImportRunText,
  setNotes,
  setSettingLabel,
  supersedeAdapterAttempts,
} from "./drizzle-person-deletion.repository";

/** The {@link MentionStore} of one company, on `tx`. */
export function drizzleMentionStore(tx: Transaction, companyId: string): MentionStore {
  return {
    events: (needles) => listEventsMentioning(tx, companyId, needles),
    setEventPayload: (id, payload) => setEventPayload(tx, id, payload),
    supersedeAdapterAttempts: (eventIds, now) => supersedeAdapterAttempts(tx, eventIds, now),
    deliveries: (needles) => listDeliveriesMentioning(tx, companyId, needles),
    rewriteDelivery: (id, values) => rewriteDelivery(tx, id, values),
    adapterErrors: (needles) => listAdapterErrorsMentioning(tx, companyId, needles),
    setAdapterError: (id, lastError) => setAdapterError(tx, id, lastError),
    importRuns: (needles) => listImportRunsMentioning(tx, companyId, needles),
    setImportRunText: (id, values) => setImportRunText(tx, id, values),
    auditSnapshots: (needles) => listAuditMentioning(tx, companyId, needles),
    setAuditSnapshots: (id, values) => setAuditSnapshots(tx, id, values),
    notes: (needles) => listNotesMentioning(tx, companyId, needles),
    setNotes: (id, values) => setNotes(tx, id, values),
    settingLabels: (needles) => listSettingLabelsMentioning(tx, companyId, needles),
    setSettingLabel: (label, text) => setSettingLabel(tx, label, text),
  };
}
